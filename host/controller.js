/**
 * The single operation layer for the off-peak queue (v2).
 *
 * Both the HTTP routes, the `agent/pre-step` creation listener, and the
 * `offpeak_queue` agent tool call into this module. It owns validation, queue
 * state transitions, the snapshot shape the UI consumes, and the statistics
 * aggregation over the run ledger. Store handles persistence; engine handles
 * scheduling and execution.
 *
 * @module dsh-offpeak-queue/host/controller
 */

import path from 'node:path'
import {
  SettingsError,
  dateKeyAt,
  normalizeSettings,
  nextOffpeakStart,
  resolvePeriod,
} from './policy.js'
import { titleFromPrompt } from './store.js'

/** Freshness window for the cached model catalog. */
const CATALOG_TTL_MS = 60_000

/** Days shown in the snapshot stats summary. */
const SNAPSHOT_STATS_DAYS = 7

/** Default `/stats` window. */
const DEFAULT_STATS_DAYS = 14

/** Statuses treated as finished. */
const FINISHED_STATUSES = new Set(['done', 'failed', 'cancelled'])

/** Maximum concurrent armed creation sessions. */
const ARM_LIMIT = 20

/**
 * A user-correctable queue error with its HTTP status.
 */
export class ControllerError extends Error {
  /**
   * @param {string} message - user-facing Chinese message.
   * @param {number} [status] - HTTP status (400/404/409/500).
   */
  constructor(message, status = 400) {
    super(message)
    this.name = 'ControllerError'
    this.status = status
  }
}

/**
 * Throw when a condition is false.
 *
 * @param {unknown} condition - condition to require.
 * @param {string} message - message when unsatisfied.
 * @param {number} [status] - HTTP status.
 * @returns {void}
 */
function requireCondition(condition, message, status = 400) {
  if (!condition) throw new ControllerError(message, status)
}

/**
 * Normalize a non-empty string field, throwing a readable error otherwise.
 *
 * @param {unknown} value - candidate value.
 * @param {string} field - field label for messages.
 * @returns {string} trimmed value.
 */
function requiredString(value, field) {
  requireCondition(typeof value === 'string' && value.trim() !== '', `${field}不能为空`)
  return value.trim()
}

/**
 * Normalize editable task fields (title/prompt) present in one request body.
 *
 * @param {unknown} input - request body / tool arguments.
 * @param {{requirePrompt: boolean}} options - whether a prompt is mandatory.
 * @returns {object} normalized partial task fields.
 */
function normalizeTaskPatch(input, options) {
  requireCondition(typeof input === 'object' && input !== null && !Array.isArray(input), '请求体必须是 JSON 对象')
  const has = (key) => Object.hasOwn(input, key) && input[key] !== undefined
  const patch = {}
  if (has('prompt') || options.requirePrompt) {
    const prompt = input.prompt
    requireCondition(typeof prompt === 'string', '任务指令（prompt）必须是字符串')
    requireCondition(prompt.trim() !== '', '任务指令（prompt）不能为空')
    patch.prompt = prompt
  }
  if (has('title')) {
    const title = input.title
    requireCondition(title === null || typeof title === 'string', '标题（title）必须是字符串')
    patch.title = typeof title === 'string' ? title.trim() : ''
  }
  return patch
}

/**
 * Sum one run list into the stats range block.
 *
 * @param {object[]} runs - ledger records.
 * @returns {{runs: number, saved: number, cost: number, peakCost: number, peakExtra: number, unpricedRuns: number}} aggregate.
 */
function aggregateRuns(runs) {
  const result = { runs: runs.length, saved: 0, cost: 0, peakCost: 0, peakExtra: 0, unpricedRuns: 0 }
  const add = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
  for (const run of runs) {
    result.saved += add(run.saved)
    result.cost += add(run.cost)
    result.peakCost += add(run.peakCost)
    result.peakExtra += add(run.peakExtra)
    if (run.unpriced) result.unpricedRuns += 1
  }
  return result
}

/**
 * Create the queue controller.
 *
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   engine: {tickNow: Function, activeCount: Function, cancelTask: Function, startTask: Function},
 *   guidance: {register: Function, unregister: Function},
 *   logger?: {warn: Function},
 *   now?: () => number,
 *   services?: {
 *     modelCatalog?: () => Promise<object>,
 *     workspaces?: () => Promise<object[]>|object[],
 *     defaultCwd?: () => string,
 *     sessionTitleFor?: (sessionId: string) => string|undefined,
 *     sessionResolvable?: (sessionId: string) => Promise<boolean>|boolean,
 *     isArchived?: (sessionId: string) => boolean,
 *     workspaceExists?: (workspaceId: string) => boolean,
 *     agentFor?: (sessionId: string) => object|undefined,
 *   },
 * }} options - controller dependencies.
 * @returns {object} controller API.
 */
export function createController(options) {
  const store = options.store
  const engine = options.engine
  const guidance = options.guidance ?? { register: () => false, unregister: () => {} }
  const logger = options.logger ?? console
  const now = options.now ?? (() => Date.now())
  const services = options.services ?? {}
  const modelCatalog = services.modelCatalog ?? (async () => ({ default: null, groups: [], failures: [] }))
  const workspaces = services.workspaces ?? (() => [])
  const defaultCwd = services.defaultCwd ?? (() => process.cwd())
  const sessionTitleFor = services.sessionTitleFor ?? (() => undefined)
  const sessionResolvable = services.sessionResolvable ?? (() => true)
  const isArchived = services.isArchived ?? (() => false)
  const workspaceExists = services.workspaceExists ?? (() => true)
  const agentFor = services.agentFor ?? (() => undefined)
  let catalogCache = null

  /**
   * Log a warning without throwing.
   *
   * @param {string} message - text.
   * @returns {void}
   */
  function warn(message) {
    try {
      logger.warn(message)
    } catch {
      /* ignored */
    }
  }

  /**
   * Trigger one scheduler pass after a mutation that could start work.
   *
   * @returns {void}
   */
  function kick() {
    try {
      Promise.resolve(engine.tickNow()).catch((error) => {
        warn(`offpeak-queue: 触发调度失败：${error instanceof Error ? error.message : String(error)}`)
      })
    } catch (error) {
      warn(`offpeak-queue: 触发调度失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /**
   * Trigger one scheduler pass on the next macrotask. Creation happens inside
   * the pre-step waterfall of an armed conversation: prompting the source
   * conversation immediately would queue the execution message into the still
   * running creation turn, and a rejected (`blocked`) turn does not wake a
   * prompt queued during it. Deferring until the rejected turn closes keeps
   * the execution prompt wakeable.
   *
   * @returns {void}
   */
  function kickSoon() {
    try {
      const timer = setTimeout(() => kick(), 0)
      timer.unref?.()
    } catch {
      kick()
    }
  }

  /**
   * Read one task or throw a 404.
   *
   * @param {unknown} id - raw id.
   * @returns {object} stored task snapshot.
   */
  function requireTask(id) {
    requireCondition(typeof id === 'string' && id.trim() !== '', '缺少任务 id')
    const task = store.getTask(id.trim())
    requireCondition(task !== null, '任务不存在', 404)
    return task
  }

  /**
   * Read the model catalog with a short TTL cache (snapshots poll it).
   *
   * @returns {Promise<{default: object|null, groups: object[], failures: object[]}>} catalog.
   */
  async function catalog() {
    const stamp = now()
    if (catalogCache !== null && stamp - catalogCache.at < CATALOG_TTL_MS) return catalogCache.value
    try {
      const value = await modelCatalog()
      const normalized = {
        default: value?.default ?? null,
        groups: Array.isArray(value?.groups) ? value.groups : [],
        failures: Array.isArray(value?.failures) ? value.failures : [],
      }
      catalogCache = { at: stamp, value: normalized }
      return normalized
    } catch (error) {
      warn(`offpeak-queue: 读取模型列表失败：${error instanceof Error ? error.message : String(error)}`)
      if (catalogCache !== null) return catalogCache.value
      return { default: null, groups: [], failures: [] }
    }
  }

  /**
   * Resolve the effective workspace list.
   *
   * @returns {Promise<object[]>} `{id, title, path}` entries.
   */
  async function workspaceList() {
    try {
      const raw = await workspaces()
      if (!Array.isArray(raw)) return []
      return raw
        .filter((entry) => typeof entry?.id === 'string' && typeof entry?.path === 'string')
        .map((entry) => ({
          id: entry.id,
          title: typeof entry.title === 'string' && entry.title !== '' ? entry.title : path.basename(entry.path),
          path: entry.path,
        }))
    } catch (error) {
      warn(`offpeak-queue: 读取工作区列表失败：${error instanceof Error ? error.message : String(error)}`)
      return []
    }
  }

  /**
   * Sort tasks for the UI: running first, then queued in queue order, then
   * finished newest-first.
   *
   * @param {object} left - task.
   * @param {object} right - task.
   * @returns {number} comparator result.
   */
  function taskOrder(left, right) {
    const rank = (task) => (task.status === 'running' ? 0 : task.status === 'queued' ? 1 : 2)
    const leftRank = rank(left)
    const rightRank = rank(right)
    if (leftRank !== rightRank) return leftRank - rightRank
    if (leftRank === 0) return (left.startedAt ?? left.updatedAt) - (right.startedAt ?? right.updatedAt)
    if (leftRank === 1) return left.order - right.order || left.createdAt - right.createdAt
    return right.updatedAt - left.updatedAt
  }

  /**
   * Attach the derived snapshot fields to one persisted task.
   *
   * @param {object} task - persisted task.
   * @param {{kind: string, nextOffpeakAt: number}} period - current period.
   * @param {number} stamp - snapshot clock.
   * @returns {object} snapshot task.
   */
  function decorateTask(task, period, stamp) {
    let nextRunAt = null
    if (task.status === 'queued') {
      nextRunAt = task.forceRun ? stamp : period.kind === 'offpeak' ? stamp : period.nextOffpeakAt
    }
    let sourceSessionTitle
    if (typeof task.sourceSessionId === 'string') {
      try {
        sourceSessionTitle = sessionTitleFor(task.sourceSessionId)
      } catch {
        sourceSessionTitle = undefined
      }
    }
    return {
      ...task,
      nextRunAt,
      estimateOffPeak: period.kind === 'offpeak',
      ...(sourceSessionTitle === undefined || sourceSessionTitle === null ? {} : { sourceSessionTitle }),
    }
  }

  /**
   * Build the 7-day stats summary carried by the snapshot.
   *
   * @returns {object} stats summary.
   */
  function statsSummary() {
    const stamp = now()
    const settings = store.getSettings()
    const runs = store.listRuns()
    const from = stamp - SNAPSHOT_STATS_DAYS * 86_400_000
    return {
      lifetime: store.getLifetime(),
      range: aggregateRuns(runs.filter((run) => run.finishedAt >= from)),
      pricesVerifiedAt: settings.pricesVerifiedAt,
    }
  }

  /**
   * Build the full UI snapshot.
   *
   * @returns {Promise<object>} snapshot payload.
   */
  async function snapshot() {
    const stamp = now()
    const settings = store.getSettings()
    const period = resolvePeriod(stamp, settings)
    const catalogValue = await catalog()
    const tasks = store.listTasks().map((task) => decorateTask(task, period, stamp)).sort(taskOrder)
    const models = []
    for (const group of catalogValue.groups) {
      if (typeof group?.id !== 'string' || !Array.isArray(group.models)) continue
      for (const model of group.models) {
        if (typeof model?.id !== 'string') continue
        models.push({ provider: group.id, model: model.id, name: typeof model.name === 'string' ? model.name : model.id })
      }
    }
    const defaultSelection = catalogValue.default
    const defaultModel = defaultSelection !== null && typeof defaultSelection?.provider === 'string' && typeof defaultSelection?.model === 'string'
      ? { provider: defaultSelection.provider, model: defaultSelection.model }
      : null
    return {
      ok: true,
      now: stamp,
      period,
      settings,
      counts: store.counts(),
      tasks,
      workspaces: await workspaceList(),
      models,
      defaultModel,
      defaultCwd: defaultCwd(),
      engine: {
        active: engine.activeCount(),
        autoRun: settings.autoRun,
        dataFile: store.dataFile,
      },
      armed: store.listArmed(),
      stats: statsSummary(),
    }
  }

  /**
   * Build the statistics payload (`GET /stats`).
   *
   * @param {unknown} rawDays - requested window in days (default 14, clamp 1–365).
   * @returns {object} stats payload.
   */
  function stats(rawDays) {
    let days = DEFAULT_STATS_DAYS
    if (rawDays !== undefined && rawDays !== null && String(rawDays).trim() !== '') {
      const parsed = Number(rawDays)
      requireCondition(Number.isFinite(parsed), 'days 必须是数字')
      days = Math.min(365, Math.max(1, Math.trunc(parsed)))
    }
    const stamp = now()
    const settings = store.getSettings()
    const runs = store.listRuns()
    const from = stamp - days * 86_400_000
    const inRange = runs.filter((run) => run.finishedAt >= from)
    const byDayMap = new Map()
    for (const run of inRange) {
      const date = dateKeyAt(run.finishedAt, settings.timeZone)
      let entry = byDayMap.get(date)
      if (entry === undefined) {
        entry = { date, runs: 0, cost: 0, peakCost: 0, saved: 0, peakExtra: 0 }
        byDayMap.set(date, entry)
      }
      const add = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      entry.runs += 1
      entry.cost += add(run.cost)
      entry.peakCost += add(run.peakCost)
      entry.saved += add(run.saved)
      entry.peakExtra += add(run.peakExtra)
    }
    const byDay = [...byDayMap.values()].sort((left, right) => left.date.localeCompare(right.date))
    const byModelMap = new Map()
    for (const run of inRange) {
      // Zero-step runs (failed starts, cancelled before any assistant message)
      // have no measured model usage; never attribute them to an "unknown" model.
      if (run.steps.length === 0) continue
      if (typeof run.provider !== 'string' || typeof run.model !== 'string') continue
      const provider = run.provider
      const model = run.model
      const key = `${provider}\u0000${model}`
      let entry = byModelMap.get(key)
      if (entry === undefined) {
        entry = { model, provider, runs: 0, cost: 0, saved: 0, unpriced: false }
        byModelMap.set(key, entry)
      }
      const add = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
      entry.runs += 1
      entry.cost += add(run.cost)
      entry.saved += add(run.saved)
      if (run.unpriced) entry.unpriced = true
    }
    const recentRuns = runs
      .slice(-20)
      .reverse()
      .map((run) => ({
        id: run.id,
        taskId: run.taskId,
        sessionId: run.sessionId,
        title: run.title,
        model: run.model,
        provider: run.provider,
        trigger: run.trigger,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
        status: run.status,
        usage: run.usage,
        cost: run.cost,
        peakCost: run.peakCost,
        saved: run.saved,
        peakExtra: run.peakExtra,
        unpriced: run.unpriced,
        stepCount: run.steps.length,
      }))
    return {
      ok: true,
      now: stamp,
      days,
      lifetime: store.getLifetime(),
      range: aggregateRuns(inRange),
      byDay,
      byModel: [...byModelMap.values()],
      recentRuns,
      pricesVerifiedAt: settings.pricesVerifiedAt,
    }
  }

  /**
   * Compact list for the agent tool: tasks, counts, and the current period.
   *
   * @param {number} [limit] - maximum tasks returned.
   * @returns {{now: number, period: object, settings: object, counts: object, tasks: object[]}} summary.
   */
  function listSummary(limit = 20) {
    const stamp = now()
    const settings = store.getSettings()
    const period = resolvePeriod(stamp, settings)
    const tasks = store.listTasks().map((task) => decorateTask(task, period, stamp)).sort(taskOrder).slice(0, limit)
    return { now: stamp, period, settings, counts: store.counts(), tasks }
  }

  /**
   * Arm one creation session. The session must exist (live or resumable), must
   * not be archived, and the workspace must be known.
   *
   * @param {unknown} rawSessionId - session id.
   * @param {unknown} workspaceId - workspace the session belongs to.
   * @returns {Promise<{ok: true, armed: object}>} arm record.
   */
  async function arm(rawSessionId, workspaceId, options = {}) {
    const sessionId = requiredString(rawSessionId, '会话 id')
    requireCondition(typeof workspaceId === 'string' && workspaceId.trim() !== '', '缺少 workspaceId')
    requireCondition(workspaceExists(workspaceId.trim()) !== false, '工作区不存在', 404)
    requireCondition(!isArchived(sessionId), '该对话已归档，无法创建闲时任务', 409)
    const resolvable = await sessionResolvable(sessionId)
    requireCondition(resolvable !== false, '会话不存在或不可恢复', 404)
    const taskId = typeof options?.taskId === 'string' && options.taskId.trim() !== '' ? options.taskId.trim() : null
    if (taskId !== null) {
      const task = store.getTask(taskId)
      requireCondition(task !== null, '任务不存在', 404)
      requireCondition(task.status === 'queued', '只有等待中的任务可以修改', 409)
      requireCondition(task.sourceSessionId === sessionId, '该任务不属于当前对话', 409)
    }
    store.pruneArms()
    const existing = store.getArmed(sessionId)
    if (existing === null && store.listArmed().length >= ARM_LIMIT) {
      throw new ControllerError(`待创建对话已达上限（${ARM_LIMIT} 个），请先取消一个`, 409)
    }
    const armed = store.armSession(sessionId, workspaceId.trim(), taskId === null ? {} : { mode: 'update', taskId })
    return { ok: true, armed }
  }

  /**
   * Disarm one creation session (idempotent).
   *
   * @param {unknown} rawSessionId - session id.
   * @returns {{ok: true, disarmed: true}} acknowledgement.
   */
  function disarm(rawSessionId) {
    const sessionId = requiredString(rawSessionId, '会话 id')
    store.disarmSession(sessionId)
    return { ok: true, disarmed: true }
  }

  /**
   * Create a queued task from a pre-step-intercepted creation message. The
   * zero-call creation counter is incremented and the session disarmed here so
   * the interruption cannot be replayed.
   *
   * @param {{sessionId: string, workspaceId?: string|null, text: string, title?: string, cwd?: string, content?: object[]}} input - intercepted creation.
   * @returns {object|null} created task.
   */
  function createTaskFromCreation(input) {
    requireCondition(typeof input?.sessionId === 'string' && input.sessionId !== '', '缺少来源会话 id')
    requireCondition(typeof input.text === 'string' && input.text.trim() !== '', '任务描述不能为空')
    const task = store.createTask({
      title: input.title ?? titleFromPrompt(input.text),
      prompt: input.text,
      content: Array.isArray(input.content) ? input.content : [],
      sourceSessionId: input.sessionId,
      sourceWorkspaceId: input.workspaceId ?? null,
      cwd: input.cwd ?? '',
    })
    store.incrementZeroCallCreations()
    store.disarmSession(input.sessionId)
    kickSoon()
    return task
  }

  /**
   * Update a queued task from a pre-step-intercepted edit message. The task id
   * is fixed by the arm record, the prompt/title follow the submitted text, and
   * the session disarms so the edit cannot be replayed.
   *
   * @param {{sessionId: string, taskId: string, text: string, title?: string, content?: object[]}} input - intercepted edit.
   * @returns {object|null} updated task.
   */
  function updateTaskFromCreation(input) {
    requireCondition(typeof input?.sessionId === 'string' && input.sessionId !== '', '缺少来源会话 id')
    requireCondition(typeof input.taskId === 'string' && input.taskId !== '', '缺少任务 id')
    requireCondition(typeof input.text === 'string' && input.text.trim() !== '', '任务描述不能为空')
    const existing = store.getTask(input.taskId)
    requireCondition(existing !== null, '任务不存在', 404)
    requireCondition(existing.status === 'queued', '只有等待中的任务可以修改', 409)
    requireCondition(existing.sourceSessionId === input.sessionId, '该任务不属于当前对话', 409)
    const prompt = input.text
    const task = store.updateTask(input.taskId, {
      prompt,
      title: input.title ?? titleFromPrompt(prompt),
      content: Array.isArray(input.content) ? input.content : [],
    })
    requireCondition(task !== null, '任务不存在', 404)
    store.disarmSession(input.sessionId)
    kickSoon()
    return task
  }

  /**
   * Create a queued task bound to the calling conversation (tool `add`).
   *
   * @param {string|null} sessionId - calling session id.
   * @param {object} input - `{title?, prompt, cwd?}`.
   * @returns {{ok: true, task: object}} created task.
   */
  function addTaskFromTool(sessionId, input) {
    requireCondition(typeof sessionId === 'string' && sessionId !== '', 'add 需要在会话中调用')
    const patch = normalizeTaskPatch(input, { requirePrompt: true })
    const prompt = patch.prompt
    const title = patch.title === undefined || patch.title === '' ? titleFromPrompt(prompt) : patch.title
    const task = store.createTask({
      title,
      prompt,
      sourceSessionId: sessionId,
      sourceWorkspaceId: null,
      cwd: typeof input.cwd === 'string' ? input.cwd : '',
    })
    kickSoon()
    return { ok: true, task }
  }

  /**
   * Update one queued task.
   *
   * @param {string} id - task id.
   * @param {object} input - partial task fields.
   * @returns {{ok: true, task: object}} updated task.
   */
  function updateTask(id, input) {
    const existing = requireTask(id)
    requireCondition(existing.status === 'queued', '只有等待中的任务可以修改', 409)
    const patch = normalizeTaskPatch(input, { requirePrompt: false })
    const prompt = Object.hasOwn(patch, 'prompt') ? patch.prompt : existing.prompt
    if (Object.hasOwn(patch, 'title')) {
      patch.title = patch.title === '' ? titleFromPrompt(prompt) : patch.title
    }
    const task = store.updateTask(id.trim(), patch)
    requireCondition(task !== null, '任务不存在', 404)
    kick()
    return { ok: true, task }
  }

  /**
   * Cancel a queued or running task. A running task settles as cancelled; its
   * collected steps are still recorded on the late runner outcome.
   *
   * @param {string} id - task id.
   * @returns {{ok: true, task: object}} cancelled task.
   */
  function cancel(id) {
    const task = requireTask(id)
    if (task.status === 'queued') {
      const cancelled = store.cancelQueued(id.trim())
      requireCondition(cancelled !== null, '任务不存在', 404)
      guidance.unregister(task.id)
      return { ok: true, task: cancelled }
    }
    if (task.status === 'running') {
      engine.cancelTask(id.trim())
      const cancelled = store.finishRun(id.trim(), { status: 'cancelled', turnEndKind: 'aborted' })
      requireCondition(cancelled !== null, '任务不存在', 404)
      guidance.unregister(task.id)
      kick()
      return { ok: true, task: cancelled }
    }
    throw new ControllerError('任务已结束，无法取消', 409)
  }

  /**
   * Requeue one finished task (same source conversation).
   *
   * @param {string} id - task id.
   * @returns {{ok: true, task: object}} requeued task.
   */
  function retry(id) {
    const task = requireTask(id)
    requireCondition(FINISHED_STATUSES.has(task.status), '只有已结束（完成/失败/取消）的任务可以重试', 409)
    const requeued = store.retryTask(id.trim())
    requireCondition(requeued !== null, '任务不存在', 404)
    try {
      const agent = agentFor(task.sourceSessionId)
      if (agent !== undefined && agent !== null) guidance.register(agent, requeued)
    } catch (error) {
      warn(`offpeak-queue: 重试后注册任务指引失败：${error instanceof Error ? error.message : String(error)}`)
    }
    kick()
    return { ok: true, task: requeued }
  }

  /**
   * Start one named task immediately (manual, any time, no confirmation).
   *
   * The tool's `run_current` executes from inside its own conversation turn and
   * passes `{waitForIdle:false}`: its execution prompt is queued for the next
   * turn boundary, so waiting for the current (still open) turn would deadlock.
   *
   * @param {string} id - task id.
   * @param {{waitForIdle?: boolean}} [options] - run options forwarded to the engine.
   * @returns {Promise<{ok: true, task: object}>} started (or start-failed) task.
   */
  async function startTask(id, options = {}) {
    const task = requireTask(id)
    requireCondition(task.status === 'queued', '只有等待中的任务可以立即执行', 409)
    const started = await engine.startTask(task.id, 'manual', options)
    requireCondition(started !== null, '任务不存在', 404)
    return { ok: true, task: started }
  }

  /**
   * Delete one non-running task. Its runs stay in the ledger.
   *
   * @param {string} id - task id.
   * @returns {{ok: true, deleted: true}} deletion acknowledgement.
   */
  function remove(id) {
    const task = requireTask(id)
    requireCondition(task.status !== 'running', '执行中的任务不能删除，请先取消', 409)
    const removed = store.removeTask(id.trim())
    requireCondition(removed, '任务不存在', 404)
    guidance.unregister(task.id)
    return { ok: true, deleted: true }
  }

  /**
   * Move one queued task up or down.
   *
   * @param {string} id - task id.
   * @param {unknown} direction - `up` or `down`.
   * @returns {{ok: true, taskIds: string[]}} queued ids in order (v2 wire field).
   */
  function move(id, direction) {
    requireCondition(direction === 'up' || direction === 'down', 'direction 必须是 up 或 down')
    const task = requireTask(id)
    requireCondition(task.status === 'queued', '只有等待中的任务可以调整顺序', 409)
    const ids = store.moveTask(id.trim(), direction)
    requireCondition(ids !== null, '任务不存在', 404)
    return { ok: true, taskIds: ids }
  }

  /**
   * Merge a partial settings patch into the effective settings.
   *
   * @param {unknown} input - partial settings object.
   * @returns {{ok: true, settings: object}} normalized settings.
   */
  function updateSettings(input) {
    requireCondition(typeof input === 'object' && input !== null && !Array.isArray(input), '设置必须是对象')
    let next
    try {
      next = normalizeSettings(input, store.getSettings())
    } catch (error) {
      if (error instanceof SettingsError) throw new ControllerError(error.message, 400)
      throw error
    }
    const settings = store.setSettings(next)
    kick()
    return { ok: true, settings }
  }

  return {
    snapshot,
    stats,
    listSummary,
    arm,
    disarm,
    createTaskFromCreation,
    updateTaskFromCreation,
    addTaskFromTool,
    updateTask,
    cancel,
    retry,
    startTask,
    remove,
    move,
    updateSettings,
  }
}
