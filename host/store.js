/**
 * Persistence and queue mutations for the off-peak queue (v3).
 *
 * One JSON document at `$DSH_HOME/offpeak-queue.json` (or
 * `$DSH_OFFPEAK_DATA_FILE` for tests) holds the settings, the task queue, the
 * armed creation sessions, the append-only run ledger, and the lifetime
 * aggregates. Writes are atomic (tmp + rename) and debounced ~200 ms; `flush()`
 * forces one write. Loading migrates v1 documents, quarantines corrupt files,
 * prunes stale arms, and reconciles runs interrupted by a DSH restart.
 *
 * @module dsh-offpeak-queue/host/store
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { DEFAULT_SETTINGS, normalizeSettings, SettingsError } from './policy.js'
import { normalizeUsage } from './pricing.js'
import { validFamily } from './families.js'

/** Persisted format version written by this plugin. */
export const DATA_VERSION = 5

/** Statuses a task may carry. */
export const TASK_STATUSES = Object.freeze(['queued', 'running', 'done', 'failed', 'cancelled'])

/** Statuses counted as finished history. */
const FINISHED_STATUSES = new Set(['done', 'failed', 'cancelled'])

/** Finished-history cap kept in the data file. */
export const MAX_FINISHED_TASKS = 100

/** Run-ledger cap kept in the data file (lifetime aggregates survive pruning). */
export const MAX_RUNS = 5000

/** Steps kept per task / run record. */
export const MAX_STEPS = 200

/** Debounce window for the asynchronous save. */
const SAVE_DEBOUNCE_MS = 200

/** Error message recorded on a task whose run was cut off by a DSH restart. */
export const RESTART_ERROR = '执行期间 DSH 退出或被重启'

/** Arm records older than this are pruned. */
export const ARM_MAX_AGE_MS = 12 * 60 * 60 * 1000

/** Maximum concurrently armed creation sessions. */
export const ARM_MAX_COUNT = 20

/** Maximum stored title length. */
const MAX_TITLE_LENGTH = 120

/** Maximum stored prompt length. */
const MAX_PROMPT_LENGTH = 100_000

/** Maximum stored content blocks replayed with the execution instruction. */
const MAX_CONTENT_BLOCKS = 32

/** Zeroed lifetime aggregates. */
export function emptyLifetime() {
  return {
    runs: 0,
    saved: 0,
    cost: 0,
    peakCost: 0,
    peakExtra: 0,
    tokensIn: 0,
    tokensOut: 0,
    zeroCallCreations: 0,
    unpricedRuns: 0,
    familyRuns: { deepseek: 0, glm: 0 },
    glmPoints: 0,
    glmPointsSaved: 0,
  }
}

/**
 * Resolve the data file path: explicit option → test env override →
 * `$DSH_HOME` → `~/.dsh`.
 *
 * @param {string|undefined} explicit - caller-provided path.
 * @returns {string} absolute data file path.
 */
export function resolveDataFile(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') return path.resolve(explicit)
  const override = process.env.DSH_OFFPEAK_DATA_FILE
  if (typeof override === 'string' && override.trim() !== '') return path.resolve(override)
  const home = process.env.DSH_HOME
  const root = typeof home === 'string' && home.trim() !== '' ? home : path.join(os.homedir(), '.dsh')
  return path.join(root, 'offpeak-queue.json')
}

/**
 * Truncate a string to `max` characters, appending an ellipsis when cut.
 *
 * @param {string} value - source string.
 * @param {number} max - character budget.
 * @returns {string} bounded string.
 */
function clampText(value, max) {
  const text = String(value ?? '')
  if (text.length <= max) return text
  return `${text.slice(0, Math.max(0, max - 1))}…`
}

/** Labels of the default creation template; a line made only of these is not a task. */
export const TEMPLATE_LABELS = Object.freeze([
  '请描述要在闲时执行的任务',
  '任务目标',
  '验收标准',
  '输出要求',
  '相关文件或目录',
])

/**
 * Turn one prompt line into a title candidate, dropping default-template labels
 * (so a half-edited template does not title a task 「请描述要在闲时执行的任务：」).
 *
 * @param {string} rawLine - one prompt line.
 * @returns {string|null} title candidate, or null for a label-only line.
 */
function titleCandidate(rawLine) {
  let text = rawLine.trim()
  if (text === '') return null
  for (const label of TEMPLATE_LABELS) text = text.split(label).join('')
  text = text.replace(/^[\s：:，,。.、；;！!？?\-—_/\\|]+/, '').replace(/[\s：:，,。.、；;！!？?\-—_/\\|]+$/, '').trim()
  const meaningful = text.replace(/[：:，,。.、；;！!？?（）()【】[\]{} \t\-—_/\\|“”"'']/g, '').trim()
  if (meaningful === '') return null
  return text
}

/**
 * First meaningful line of a prompt, used as the title fallback. Template-label
 * lines are skipped so the title comes from the user's real description.
 *
 * @param {string} prompt - task prompt.
 * @returns {string} fallback title (≤120 chars, never empty).
 */
export function titleFromPrompt(prompt) {
  for (const line of String(prompt ?? '').split(/\r?\n/)) {
    const candidate = titleCandidate(line)
    if (candidate !== null) return clampText(candidate, MAX_TITLE_LENGTH)
  }
  return '未命名任务'
}

/**
 * Normalize token totals to the four documented task fields.
 *
 * @param {unknown} usage - candidate totals.
 * @returns {{inputTokens: number, outputTokens: number, cacheReadTokens: number, reasoningTokens: number}|null} totals or null.
 */
export function normalizeUsageTotals(usage) {
  if (usage === null || usage === undefined || typeof usage !== 'object') return null
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0)
  return {
    inputTokens: count(usage.inputTokens),
    outputTokens: count(usage.outputTokens),
    cacheReadTokens: count(usage.cacheReadTokens),
    reasoningTokens: count(usage.reasoningTokens),
  }
}

/**
 * Normalize one priced step record.
 *
 * @param {unknown} raw - candidate step.
 * @returns {object|null} canonical step.
 */
function sanitizeStep(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    at: numberOrNull(raw.at) ?? 0,
    tier: raw.tier === 'peak' ? 'peak' : 'offpeak',
    usage: normalizeUsage(raw.usage),
    cost: numberOrNull(raw.cost),
    peakCost: numberOrNull(raw.peakCost),
    saved: numberOrNull(raw.saved),
    peakExtra: numberOrNull(raw.peakExtra),
    points: numberOrNull(raw.points),
    pointsSaved: numberOrNull(raw.pointsSaved),
    provider: typeof raw.provider === 'string' ? raw.provider : null,
    model: typeof raw.model === 'string' ? raw.model : null,
  }
}

/**
 * Normalize the durable message content stored on a task.
 *
 * The creation message never enters the session log (a rejected step cannot
 * write one), so the task keeps its content blocks and the runner replays them
 * with the execution instruction. Only text and attachment blocks survive:
 * anything else would be a guess about a future format.
 *
 * @param {unknown} raw - candidate blocks.
 * @returns {object[]} canonical content blocks.
 */
function sanitizeContent(raw) {
  if (!Array.isArray(raw)) return []
  const blocks = []
  for (const value of raw) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    if (value.type === 'text') {
      if (typeof value.text !== 'string' || value.text === '') continue
      blocks.push({ type: 'text', text: clampText(value.text, MAX_PROMPT_LENGTH) })
    } else if (value.type === 'image' || value.type === 'file') {
      const attachment = value.attachment
      if (typeof attachment !== 'object' || attachment === null) continue
      if (typeof attachment.attachmentId !== 'string' || attachment.attachmentId === '') continue
      blocks.push({
        type: value.type,
        attachment: {
          attachmentId: attachment.attachmentId,
          ...(typeof attachment.mediaType === 'string' ? { mediaType: attachment.mediaType } : {}),
          ...(Number.isFinite(attachment.width) ? { width: attachment.width } : {}),
          ...(Number.isFinite(attachment.height) ? { height: attachment.height } : {}),
          ...(Number.isFinite(attachment.bytes) ? { bytes: attachment.bytes } : {}),
          ...(typeof attachment.name === 'string' ? { name: attachment.name } : {}),
        },
      })
    }
    if (blocks.length >= MAX_CONTENT_BLOCKS) break
  }
  return blocks
}

/**
 * Normalize the steps array.
 *
 * @param {unknown} raw - candidate array.
 * @returns {object[]} canonical steps.
 */
function sanitizeSteps(raw) {
  if (!Array.isArray(raw)) return []
  return raw.map(sanitizeStep).filter((step) => step !== null).slice(-MAX_STEPS)
}

/**
 * Coerce one possibly-tampered v2 task record into the canonical Task shape.
 *
 * @param {unknown} raw - candidate from the data file.
 * @param {number} now - fallback timestamp.
 * @returns {object|null} canonical task, or null when unusable.
 */
function sanitizeTask(raw, now) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : null
  const sourceSessionId = typeof raw.sourceSessionId === 'string' && raw.sourceSessionId !== '' ? raw.sourceSessionId : null
  if (id === null || sourceSessionId === null) return null
  const status = TASK_STATUSES.includes(raw.status) ? raw.status : 'failed'
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : now
  const updatedAt = Number.isFinite(raw.updatedAt) ? raw.updatedAt : createdAt
  const title = clampText(typeof raw.title === 'string' && raw.title.trim() !== '' ? raw.title.trim() : titleFromPrompt(raw.prompt), MAX_TITLE_LENGTH)
  const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  return {
    id,
    order: Number.isFinite(raw.order) ? Math.trunc(raw.order) : 0,
    title,
    prompt: clampText(typeof raw.prompt === 'string' ? raw.prompt : '', MAX_PROMPT_LENGTH),
    content: sanitizeContent(raw.content),
    status,
    modelFamily: validFamily(raw.modelFamily),
    sourceSessionId,
    sessionId: typeof raw.sessionId === 'string' && raw.sessionId !== '' ? raw.sessionId : sourceSessionId,
    sourceWorkspaceId: typeof raw.sourceWorkspaceId === 'string' && raw.sourceWorkspaceId !== '' ? raw.sourceWorkspaceId : null,
    cwd: typeof raw.cwd === 'string' ? raw.cwd : '',
    createdAt,
    updatedAt,
    startedAt: numberOrNull(raw.startedAt),
    finishedAt: numberOrNull(raw.finishedAt),
    attempts: Number.isInteger(raw.attempts) && raw.attempts >= 0 ? raw.attempts : 0,
    forceRun: raw.forceRun === true,
    runTrigger: raw.runTrigger === 'offpeak' || raw.runTrigger === 'manual' ? raw.runTrigger : null,
    turnEndKind: typeof raw.turnEndKind === 'string' && raw.turnEndKind !== '' ? raw.turnEndKind : null,
    error: typeof raw.error === 'string' && raw.error !== '' ? clampText(raw.error, 400) : null,
    resultSnippet: typeof raw.resultSnippet === 'string' && raw.resultSnippet !== '' ? clampText(raw.resultSnippet, 600) : null,
    usage: normalizeUsageTotals(raw.usage),
    cost: numberOrNull(raw.cost),
    saved: numberOrNull(raw.saved),
    peakExtra: numberOrNull(raw.peakExtra),
    points: numberOrNull(raw.points),
    pointsSaved: numberOrNull(raw.pointsSaved),
    steps: sanitizeSteps(raw.steps),
    baseline: numberOrNull(raw.baseline),
  }
}

/**
 * Sanitize one armed-session record.
 *
 * @param {unknown} raw - candidate.
 * @param {string} key - map key (session id).
 * @param {number} now - fallback timestamp.
 * @returns {object|null} canonical arm record.
 */
function sanitizeArm(raw, key, now) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  if (typeof key !== 'string' || key === '') return null
  const mode = raw.mode === 'update' ? 'update' : 'create'
  return {
    sessionId: key,
    workspaceId: typeof raw.workspaceId === 'string' && raw.workspaceId !== '' ? raw.workspaceId : null,
    armedAt: Number.isFinite(raw.armedAt) ? raw.armedAt : now,
    status: 'armed',
    mode,
    taskId: mode === 'update' && typeof raw.taskId === 'string' && raw.taskId !== '' ? raw.taskId : null,
    lastError: typeof raw.lastError === 'string' && raw.lastError !== '' ? clampText(raw.lastError, 200) : null,
  }
}

/**
 * Sanitize one run-ledger record.
 *
 * @param {unknown} raw - candidate run.
 * @returns {object|null} canonical run record.
 */
function sanitizeRun(raw) {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' && raw.id !== '' ? raw.id : null
  if (id === null) return null
  const numberOrNull = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null)
  const steps = sanitizeSteps(raw.steps)
  return {
    id,
    taskId: typeof raw.taskId === 'string' ? raw.taskId : null,
    sessionId: typeof raw.sessionId === 'string' ? raw.sessionId : null,
    title: typeof raw.title === 'string' ? clampText(raw.title, MAX_TITLE_LENGTH) : '',
    modelFamily: validFamily(raw.modelFamily),
    model: typeof raw.model === 'string' && raw.model !== '' ? raw.model : null,
    provider: typeof raw.provider === 'string' && raw.provider !== '' ? raw.provider : null,
    trigger: raw.trigger === 'manual' ? 'manual' : 'offpeak',
    startedAt: Number.isFinite(raw.startedAt) ? raw.startedAt : 0,
    finishedAt: Number.isFinite(raw.finishedAt) ? raw.finishedAt : 0,
    status: TASK_STATUSES.includes(raw.status) ? raw.status : 'failed',
    steps,
    usage: normalizeUsageTotals(raw.usage) ?? { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
    cost: numberOrNull(raw.cost),
    peakCost: numberOrNull(raw.peakCost),
    saved: numberOrNull(raw.saved),
    peakExtra: numberOrNull(raw.peakExtra),
    points: numberOrNull(raw.points),
    pointsSaved: numberOrNull(raw.pointsSaved),
    unpriced: raw.unpriced === true,
  }
}

/**
 * Sanitize the lifetime aggregates, defaulting missing counters to zero.
 *
 * @param {unknown} raw - candidate lifetime block.
 * @returns {object} canonical lifetime block.
 */
function sanitizeLifetime(raw) {
  const lifetime = emptyLifetime()
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return lifetime
  for (const key of Object.keys(lifetime)) {
    if (key === 'familyRuns') continue
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      lifetime[key] = key === 'runs' || key === 'zeroCallCreations' || key === 'unpricedRuns' ? Math.trunc(value) : value
    }
  }
  const familyRuns = raw.familyRuns
  if (typeof familyRuns === 'object' && familyRuns !== null && !Array.isArray(familyRuns)) {
    for (const id of ['deepseek', 'glm']) {
      const value = familyRuns[id]
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
        lifetime.familyRuns[id] = Math.trunc(value)
      }
    }
  }
  return lifetime
}

/**
 * Sort queued tasks by their queue order, breaking ties by creation time.
 *
 * @param {object} left - task.
 * @param {object} right - task.
 * @returns {number} comparator result.
 */
function queuedOrder(left, right) {
  if (left.order !== right.order) return left.order - right.order
  return left.createdAt - right.createdAt
}

/**
 * Create the queue store, loading the data file synchronously.
 *
 * @param {{dataFile?: string, logger?: {info: Function, warn: Function, error: Function}, now?: () => number, saveDebounceMs?: number}} [options] - store options.
 * @returns {object} store API used by the controller, pre-step listener, and engine.
 */
export function createStore(options = {}) {
  const dataFile = resolveDataFile(options.dataFile)
  const logger = options.logger ?? console
  const now = options.now ?? (() => Date.now())
  const saveDebounceMs = options.saveDebounceMs ?? SAVE_DEBOUNCE_MS
  let state = {
    version: DATA_VERSION,
    savedAt: null,
    settings: normalizeSettings({}),
    tasks: [],
    armed: {},
    runs: [],
    lifetime: emptyLifetime(),
  }
  let dirty = false
  let timer = null
  let disposed = false
  let migratedFrom = null

  /**
   * Log a warning through the Host logger without ever throwing.
   *
   * @param {string} message - message to log.
   * @returns {void}
   */
  function warn(message) {
    try {
      logger.warn(message)
    } catch {
      /* logging must never break the queue */
    }
  }

  /**
   * Assign contiguous queue orders 0..n-1 to queued tasks.
   *
   * @returns {void}
   */
  function renumberQueued() {
    const queued = state.tasks.filter((task) => task.status === 'queued').sort(queuedOrder)
    queued.forEach((task, index) => {
      task.order = index
    })
  }

  /**
   * Drop the oldest finished tasks beyond the history cap.
   *
   * @returns {boolean} whether anything was removed.
   */
  function capHistory() {
    const finished = state.tasks
      .filter((task) => FINISHED_STATUSES.has(task.status))
      .sort((left, right) => (right.finishedAt ?? right.updatedAt) - (left.finishedAt ?? left.updatedAt))
    if (finished.length <= MAX_FINISHED_TASKS) return false
    const keep = new Set(finished.slice(0, MAX_FINISHED_TASKS).map((task) => task.id))
    const before = state.tasks.length
    state.tasks = state.tasks.filter((task) => !FINISHED_STATUSES.has(task.status) || keep.has(task.id))
    return state.tasks.length !== before
  }

  /**
   * Write the current state atomically. Throws on I/O failure.
   *
   * @returns {void}
   */
  function writeNow() {
    const payload = {
      version: DATA_VERSION,
      savedAt: now(),
      settings: state.settings,
      tasks: state.tasks,
      armed: state.armed,
      runs: state.runs,
      lifetime: state.lifetime,
    }
    const body = JSON.stringify(payload)
    fs.mkdirSync(path.dirname(dataFile), { recursive: true })
    const temporary = `${dataFile}.tmp-${process.pid}-${crypto.randomBytes(2).toString('hex')}`
    fs.writeFileSync(temporary, body, 'utf8')
    fs.renameSync(temporary, dataFile)
    dirty = false
    state.savedAt = payload.savedAt
  }

  /**
   * Write immediately when state changed (and clear a pending debounce).
   *
   * @returns {boolean} true when a write happened.
   */
  function flush() {
    if (!dirty) return false
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    writeNow()
    return true
  }

  /**
   * Mark the document dirty and schedule one debounced write.
   *
   * @returns {void}
   */
  function markDirty() {
    dirty = true
    if (timer !== null || disposed) return
    timer = setTimeout(() => {
      timer = null
      if (!dirty) return
      try {
        writeNow()
      } catch (error) {
        warn(`offpeak-queue: 保存队列失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }, saveDebounceMs)
    timer.unref?.()
  }

  /**
   * Commit one mutation: renumber, cap history, persist.
   *
   * @returns {void}
   */
  function commit() {
    renumberQueued()
    capHistory()
    markDirty()
  }

  /**
   * Clone a task for callers so stored state cannot be mutated outside.
   *
   * @param {object|null|undefined} task - stored task.
   * @returns {object|null} detached task.
   */
  function copyTask(task) {
    if (task === undefined || task === null) return null
    return {
      ...task,
      usage: task.usage === null ? null : { ...task.usage },
      content: Array.isArray(task.content) ? task.content.map((block) => ({ ...block })) : [],
      steps: task.steps.map((step) => ({ ...step, usage: { ...step.usage } })),
    }
  }

  /**
   * Find the index of one task by id.
   *
   * @param {string} id - task id.
   * @returns {number} index or -1.
   */
  function indexOf(id) {
    return state.tasks.findIndex((task) => task.id === id)
  }

  /**
   * Mint a unique, URL-safe task id.
   *
   * @returns {string} task id.
   */
  function mintTaskId() {
    for (;;) {
      const id = `t-${now()}-${crypto.randomBytes(3).toString('hex')}`
      if (indexOf(id) === -1) return id
    }
  }

  /**
   * Copy settings for callers.
   *
   * @param {object} settings - settings record.
   * @returns {object} detached copy.
   */
  function cloneSettings(settings) {
    return {
      ...settings,
      peakWindows: settings.peakWindows.map((window) => ({ weekdays: [...window.weekdays], start: window.start, end: window.end })),
      holidays: [...settings.holidays],
      holidayYears: [...settings.holidayYears],
      prices: Object.fromEntries(Object.entries(settings.prices).map(([model, entry]) => [model, { ...entry }])),
      familyEnabled: { ...settings.familyEnabled },
    }
  }

  /**
   * Replace the settings object after validation.
   *
   * @param {object} settings - normalized settings.
   * @returns {object} detached settings copy.
   */
  function setSettings(settings) {
    state.settings = normalizeSettings(settings)
    markDirty()
    return cloneSettings(state.settings)
  }

  /**
   * Read the effective settings.
   *
   * @returns {object} detached settings copy.
   */
  function getSettings() {
    return cloneSettings(state.settings)
  }

  /**
   * Migrate a version-1 document: keep settings, drop tasks created by the v1
   * form flow (no `sourceSessionId`), start fresh arms/runs/lifetime.
   *
   * @param {object} parsed - parsed v1 document.
   * @returns {void}
   */
  function migrateV1(parsed) {
    migratedFrom = 1
    try {
      state.settings = normalizeSettings(parsed.settings ?? {}, DEFAULT_SETTINGS)
    } catch {
      state.settings = normalizeSettings({})
    }
    const dropped = Array.isArray(parsed.tasks) ? parsed.tasks.length : 0
    state.tasks = []
    state.armed = {}
    state.runs = []
    state.lifetime = emptyLifetime()
    warn(`offpeak-queue: 数据从 v1 迁移到 v${DATA_VERSION}，已丢弃 ${dropped} 个无来源对话的旧任务`)
    markDirty()
  }

  /**
   * Migrate a version-2 document to v3: the concurrency default moved from 1
   * to 3, so a stored old default is lifted while an explicit value survives.
   *
   * @returns {void}
   */
  function migrateV2Settings() {
    if (state.settings.maxConcurrent === 1) state.settings.maxConcurrent = 3
    warn(`offpeak-queue: 数据从 v2 迁移到 v${DATA_VERSION}，最大并发默认值改为 3`)
    markDirty()
  }

  /**
   * Migrate a version-3 document to v4: automatic execution is mandatory now,
   * so the removed `autoRun` switch is forced back on.
   *
   * @returns {void}
   */
  function migrateV3Settings() {
    state.settings.autoRun = true
    warn(`offpeak-queue: 数据从 v3 迁移到 v${DATA_VERSION}，闲时任务改为始终自动执行`)
    markDirty()
  }

  /**
   * Migrate a version-4 document to v5: the multi-family update adds
   * `modelFamily` (defaults to DeepSeek through sanitization) and the
   * per-family enable switches plus GLM credit counters (defaults via
   * `normalizeSettings`/`sanitizeLifetime`), so no field surgery is needed —
   * only a persisted version bump.
   *
   * @returns {void}
   */
  function migrateV4Document() {
    warn(`offpeak-queue: 数据从 v4 迁移到 v${DATA_VERSION}，任务补充模型维度（默认 DeepSeek），新增按模型开关与 GLM 积分统计`)
    markDirty()
  }

  /**
   * Move a corrupt/incompatible data file aside and start from a clean state.
   *
   * @param {string} reason - why the file was rejected.
   * @returns {void}
   */
  function quarantine(reason) {
    const target = `${dataFile}.corrupt-${new Date(now()).toISOString().replace(/[:.]/g, '-')}`
    try {
      fs.renameSync(dataFile, target)
      warn(`offpeak-queue: 队列文件已损坏（${reason}），已备份到 ${target} 并重建空队列`)
    } catch (error) {
      warn(`offpeak-queue: 队列文件已损坏（${reason}）且无法备份：${error instanceof Error ? error.message : String(error)}`)
    }
    state = {
      version: DATA_VERSION,
      savedAt: null,
      settings: normalizeSettings({}),
      tasks: [],
      armed: {},
      runs: [],
      lifetime: emptyLifetime(),
    }
  }

  /**
   * Prune stale/excess armed sessions.
   *
   * @param {number} [maxAgeMs] - arm age limit.
   * @param {number} [maxCount] - maximum arms kept.
   * @returns {number} number of arms removed.
   */
  function pruneArms(maxAgeMs = ARM_MAX_AGE_MS, maxCount = ARM_MAX_COUNT) {
    const stamp = now()
    let removed = 0
    for (const [sessionId, arm] of Object.entries(state.armed)) {
      if (stamp - arm.armedAt > maxAgeMs) {
        delete state.armed[sessionId]
        removed += 1
      }
    }
    const remaining = Object.values(state.armed).sort((left, right) => left.armedAt - right.armedAt)
    if (remaining.length > maxCount) {
      for (const arm of remaining.slice(0, remaining.length - maxCount)) {
        delete state.armed[arm.sessionId]
        removed += 1
      }
    }
    if (removed > 0) markDirty()
    return removed
  }

  /**
   * Load (or recover/migrate) the persisted document into memory.
   *
   * @returns {void}
   */
  function load() {
    let raw
    try {
      raw = fs.readFileSync(dataFile, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') return
      warn(`offpeak-queue: 读取队列文件失败，将以空队列启动：${error instanceof Error ? error.message : String(error)}`)
      return
    }
    let parsed
    try {
      parsed = JSON.parse(raw)
    } catch {
      quarantine('不是合法 JSON')
      return
    }
    if (typeof parsed !== 'object' || parsed === null || (parsed.version !== DATA_VERSION && parsed.version !== 4 && parsed.version !== 3 && parsed.version !== 2 && parsed.version !== 1)) {
      quarantine(`数据版本不受支持（${String(parsed?.version)}）`)
      return
    }
    if (parsed.version === 1) {
      migrateV1(parsed)
      return
    }
    const fromVersion = parsed.version
    migratedFrom = fromVersion
    if (Array.isArray(parsed.tasks)) {
      const seen = new Set()
      const tasks = []
      for (const entry of parsed.tasks) {
        const task = sanitizeTask(entry, now())
        if (task === null || seen.has(task.id)) continue
        seen.add(task.id)
        tasks.push(task)
      }
      state.tasks = tasks
    }
    if (typeof parsed.armed === 'object' && parsed.armed !== null && !Array.isArray(parsed.armed)) {
      const armed = {}
      for (const [sessionId, entry] of Object.entries(parsed.armed)) {
        const arm = sanitizeArm(entry, sessionId, now())
        if (arm !== null) armed[sessionId] = arm
      }
      state.armed = armed
    }
    if (Array.isArray(parsed.runs)) {
      state.runs = parsed.runs.map(sanitizeRun).filter((run) => run !== null).slice(-MAX_RUNS)
    }
    state.lifetime = sanitizeLifetime(parsed.lifetime)
    try {
      state.settings = normalizeSettings(parsed.settings ?? {}, DEFAULT_SETTINGS)
    } catch (error) {
      warn(`offpeak-queue: 队列文件中的设置无效，已恢复默认设置：${error instanceof Error ? error.message : String(error)}`)
      state.settings = normalizeSettings({})
    }
    if (fromVersion === 2) migrateV2Settings()
    if (fromVersion === 2 || fromVersion === 3) migrateV3Settings()
    if (fromVersion === 4) migrateV4Document()
    let recovered = false
    for (const task of state.tasks) {
      if (task.status !== 'running') continue
      task.status = 'failed'
      task.error = RESTART_ERROR
      task.turnEndKind = 'interrupted'
      task.finishedAt = now()
      task.updatedAt = now()
      recovered = true
    }
    if (recovered) {
      warn('offpeak-queue: 上次运行期间队列任务被中断，已标记为失败')
      commit()
    } else {
      renumberQueued()
      capHistory()
    }
    pruneArms()
  }

  /**
   * Add one queued task bound to its source conversation.
   *
   * @param {{title: string, prompt: string, content?: object[], sourceSessionId: string, sourceWorkspaceId?: string|null, cwd?: string}} fields - validated task fields.
   * @returns {object} detached new task.
   */
  function createTask(fields) {
    const timestamp = now()
    const task = {
      id: mintTaskId(),
      order: state.tasks.filter((entry) => entry.status === 'queued').length,
      title: clampText(fields.title, MAX_TITLE_LENGTH),
      prompt: clampText(fields.prompt, MAX_PROMPT_LENGTH),
      content: sanitizeContent(fields.content),
      status: 'queued',
      modelFamily: validFamily(fields.modelFamily),
      sourceSessionId: fields.sourceSessionId,
      sessionId: fields.sourceSessionId,
      sourceWorkspaceId: fields.sourceWorkspaceId ?? null,
      cwd: fields.cwd ?? '',
      createdAt: timestamp,
      updatedAt: timestamp,
      startedAt: null,
      finishedAt: null,
      attempts: 0,
      forceRun: false,
      runTrigger: null,
      turnEndKind: null,
      error: null,
      resultSnippet: null,
      usage: null,
      cost: null,
      saved: null,
      peakExtra: null,
      points: null,
      pointsSaved: null,
      steps: [],
      baseline: null,
    }
    state.tasks.push(task)
    commit()
    return copyTask(task)
  }

  /**
   * Update the editable fields (title/prompt/content) of one queued task.
   *
   * @param {string} id - task id.
   * @param {object} patch - validated partial fields.
   * @returns {object|null} detached task.
   */
  function updateTask(id, patch) {
    const index = indexOf(id)
    if (index === -1) return null
    const task = state.tasks[index]
    if (Object.hasOwn(patch, 'title')) task.title = clampText(patch.title, MAX_TITLE_LENGTH)
    if (Object.hasOwn(patch, 'prompt')) task.prompt = clampText(patch.prompt, MAX_PROMPT_LENGTH)
    if (Object.hasOwn(patch, 'content')) task.content = sanitizeContent(patch.content)
    task.updatedAt = now()
    commit()
    return copyTask(task)
  }

  /**
   * Mark one queued task as force-run (scheduler runs it even at peak).
   *
   * @param {string} id - task id.
   * @returns {object|null} detached task.
   */
  function markRunNow(id) {
    const index = indexOf(id)
    if (index === -1) return null
    const task = state.tasks[index]
    if (task.forceRun) return copyTask(task)
    task.forceRun = true
    task.updatedAt = now()
    markDirty()
    return copyTask(task)
  }

  /**
   * Cancel a queued task.
   *
   * @param {string} id - task id.
   * @returns {object|null} detached task.
   */
  function cancelQueued(id) {
    const index = indexOf(id)
    if (index === -1) return null
    const task = state.tasks[index]
    const timestamp = now()
    task.status = 'cancelled'
    task.forceRun = false
    task.finishedAt = timestamp
    task.updatedAt = timestamp
    task.runTrigger = null
    commit()
    return copyTask(task)
  }

  /**
   * Move one finished task back into the queue (same source conversation).
   *
   * @param {string} id - task id.
   * @returns {object|null} detached task.
   */
  function retryTask(id) {
    const index = indexOf(id)
    if (index === -1) return null
    const task = state.tasks[index]
    const timestamp = now()
    task.status = 'queued'
    task.order = state.tasks.filter((entry) => entry.status === 'queued').length
    task.forceRun = false
    task.startedAt = null
    task.finishedAt = null
    task.sessionId = task.sourceSessionId
    task.turnEndKind = null
    task.error = null
    task.resultSnippet = null
    task.usage = null
    task.cost = null
    task.saved = null
    task.peakExtra = null
    task.points = null
    task.pointsSaved = null
    task.steps = []
    task.baseline = null
    task.runTrigger = null
    task.updatedAt = timestamp
    commit()
    return copyTask(task)
  }

  /**
   * Delete one non-running task.
   *
   * @param {string} id - task id.
   * @returns {boolean} whether a task was removed.
   */
  function removeTask(id) {
    const index = indexOf(id)
    if (index === -1) return false
    state.tasks.splice(index, 1)
    commit()
    return true
  }

  /**
   * Move one queued task up or down the queue.
   *
   * @param {string} id - task id.
   * @param {'up'|'down'} direction - move direction.
   * @returns {string[]|null} queued ids in order, or null when the task is unknown.
   */
  function moveTask(id, direction) {
    const queued = state.tasks.filter((task) => task.status === 'queued').sort(queuedOrder)
    const index = queued.findIndex((task) => task.id === id)
    if (index === -1) return null
    const target = direction === 'up' ? index - 1 : index + 1
    if (target < 0 || target >= queued.length) return queued.map((task) => task.id)
    const [moved] = queued.splice(index, 1)
    queued.splice(target, 0, moved)
    queued.forEach((task, order) => {
      const stored = state.tasks[indexOf(task.id)]
      stored.order = order
    })
    commit()
    return queued.map((task) => task.id)
  }

  /**
   * Claim one queued task for execution.
   *
   * @param {string} id - task id.
   * @param {'offpeak'|'manual'} runTrigger - why the run started.
   * @returns {object|null} detached running task, or null when it was not queued.
   */
  function startRun(id, runTrigger) {
    const index = indexOf(id)
    if (index === -1) return null
    const task = state.tasks[index]
    if (task.status !== 'queued') return null
    const timestamp = now()
    task.status = 'running'
    task.sessionId = task.sourceSessionId
    task.forceRun = false
    task.attempts += 1
    task.startedAt = timestamp
    task.updatedAt = timestamp
    task.finishedAt = null
    task.turnEndKind = null
    task.error = null
    task.resultSnippet = null
    task.usage = null
    task.cost = null
    task.saved = null
    task.peakExtra = null
    task.points = null
    task.pointsSaved = null
    task.steps = []
    task.baseline = null
    task.runTrigger = runTrigger
    commit()
    return copyTask(task)
  }

  /**
   * Record the session sequence baseline observed just before the execution
   * prompt was admitted.
   *
   * @param {string} id - task id.
   * @param {number|null} baseline - session seq baseline.
   * @returns {object|null} detached task.
   */
  function setRunBaseline(id, baseline) {
    const index = indexOf(id)
    if (index === -1) return null
    const task = state.tasks[index]
    if (task.baseline === baseline) return copyTask(task)
    task.baseline = typeof baseline === 'number' && Number.isFinite(baseline) ? baseline : null
    task.updatedAt = now()
    markDirty()
    return copyTask(task)
  }

  /**
   * Record the settled outcome of one run. A task already cancelled by the user
   * accepts the same-status late patch so the collected steps/costs are kept.
   *
   * @param {string} id - task id.
   * @param {object} outcome - settled result fields.
   * @returns {object|null} detached task.
   */
  function finishRun(id, outcome) {
    const index = indexOf(id)
    if (index === -1) return null
    const task = state.tasks[index]
    if (task.status !== 'running' && task.status !== outcome.status) return copyTask(task)
    const timestamp = now()
    task.status = outcome.status
    if (typeof task.sourceSessionId === 'string') task.sessionId = task.sourceSessionId
    task.finishedAt = task.finishedAt ?? timestamp
    task.updatedAt = timestamp
    task.turnEndKind = outcome.turnEndKind ?? null
    task.error = outcome.error === null || outcome.error === undefined ? null : clampText(outcome.error, 400)
    task.resultSnippet = outcome.resultSnippet === null || outcome.resultSnippet === undefined ? null : clampText(outcome.resultSnippet, 600)
    task.usage = normalizeUsageTotals(outcome.usage)
    task.cost = typeof outcome.cost === 'number' ? outcome.cost : null
    task.saved = typeof outcome.saved === 'number' ? outcome.saved : null
    task.peakExtra = typeof outcome.peakExtra === 'number' ? outcome.peakExtra : null
    task.points = typeof outcome.points === 'number' ? outcome.points : null
    task.pointsSaved = typeof outcome.pointsSaved === 'number' ? outcome.pointsSaved : null
    task.steps = sanitizeSteps(outcome.steps)
    task.forceRun = false
    commit()
    return copyTask(task)
  }

  /**
   * Append one run-ledger record and fold it into the lifetime aggregates.
   *
   * @param {object} record - run record without an id.
   * @returns {object} detached stored run record.
   */
  function recordRun(record) {
    const run = sanitizeRun({
      id: `r-${now()}-${crypto.randomBytes(4).toString('hex')}`,
      ...record,
    })
    if (run === null) throw new Error('offpeak-queue: invalid run record')
    state.runs.push(run)
    if (state.runs.length > MAX_RUNS) state.runs = state.runs.slice(-MAX_RUNS)
    const lifetime = state.lifetime
    lifetime.runs += 1
    // Zero-step runs carry no provider/model, so their family defaults to
    // DeepSeek — an accepted approximation for cancelled/failed starts.
    lifetime.familyRuns[run.modelFamily] += 1
    const add = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : 0)
    lifetime.saved += add(run.saved)
    lifetime.cost += add(run.cost)
    lifetime.peakCost += add(run.peakCost)
    lifetime.peakExtra += add(run.peakExtra)
    if (run.modelFamily === 'glm') {
      lifetime.glmPoints += add(run.points)
      lifetime.glmPointsSaved += add(run.pointsSaved)
    }
    lifetime.tokensIn += run.usage.inputTokens
    lifetime.tokensOut += run.usage.outputTokens
    if (run.unpriced) lifetime.unpricedRuns += 1
    markDirty()
    return { ...run, steps: run.steps.map((step) => ({ ...step, usage: { ...step.usage } })) }
  }

  /**
   * Increment the zero-call creation counter (one pre-step task creation).
   *
   * @returns {number} new counter value.
   */
  function incrementZeroCallCreations() {
    state.lifetime.zeroCallCreations += 1
    markDirty()
    return state.lifetime.zeroCallCreations
  }

  /**
   * Copy one run record for callers.
   *
   * @param {object} run - stored run.
   * @returns {object} detached run.
   */
  function copyRun(run) {
    return { ...run, steps: run.steps.map((step) => ({ ...step, usage: { ...step.usage } })) }
  }

  /**
   * Read the run ledger (oldest first).
   *
   * @returns {object[]} detached run records.
   */
  function listRuns() {
    return state.runs.map(copyRun)
  }

  /**
   * Read the lifetime aggregates.
   *
   * @returns {object} detached lifetime block.
   */
  function getLifetime() {
    return { ...state.lifetime }
  }

  /**
   * Arm one creation session.
   *
   * @param {string} sessionId - session to arm.
   * @param {string|null} workspaceId - workspace the session was created in.
   * @returns {object} detached arm record.
   */
  function armSession(sessionId, workspaceId, options = {}) {
    const mode = options.mode === 'update' ? 'update' : 'create'
    const arm = {
      sessionId,
      workspaceId: workspaceId ?? null,
      armedAt: now(),
      status: 'armed',
      mode,
      taskId: mode === 'update' && typeof options.taskId === 'string' && options.taskId !== '' ? options.taskId : null,
      lastError: null,
    }
    state.armed[sessionId] = arm
    markDirty()
    return { ...arm }
  }

  /**
   * Read one arm record.
   *
   * @param {string} sessionId - session id.
   * @returns {object|null} detached arm record.
   */
  function getArmed(sessionId) {
    const arm = state.armed[sessionId]
    return arm === undefined ? null : { ...arm }
  }

  /**
   * List armed sessions, oldest first.
   *
   * @returns {object[]} detached arm records.
   */
  function listArmed() {
    return Object.values(state.armed)
      .map((arm) => ({ ...arm }))
      .sort((left, right) => left.armedAt - right.armedAt)
  }

  /**
   * Record the last creation error on an armed session (keeps it armed).
   *
   * @param {string} sessionId - session id.
   * @param {string} message - user-facing error.
   * @returns {object|null} detached arm record.
   */
  function setArmError(sessionId, message) {
    const arm = state.armed[sessionId]
    if (arm === undefined) return null
    arm.lastError = clampText(message, 200)
    markDirty()
    return { ...arm }
  }

  /**
   * Drop one arm record (idempotent).
   *
   * @param {string} sessionId - session id.
   * @returns {boolean} whether an arm existed.
   */
  function disarmSession(sessionId) {
    if (state.armed[sessionId] === undefined) return false
    delete state.armed[sessionId]
    markDirty()
    return true
  }

  /**
   * List every task.
   *
   * @returns {object[]} detached tasks in storage order.
   */
  function listTasks() {
    return state.tasks.map(copyTask)
  }

  /**
   * List queued tasks in queue order.
   *
   * @returns {object[]} detached queued tasks.
   */
  function listQueued() {
    return state.tasks.filter((task) => task.status === 'queued').sort(queuedOrder).map(copyTask)
  }

  /**
   * Read one task.
   *
   * @param {string} id - task id.
   * @returns {object|null} detached task.
   */
  function getTask(id) {
    const index = indexOf(id)
    return index === -1 ? null : copyTask(state.tasks[index])
  }

  /**
   * Count tasks by status.
   *
   * @returns {{queued: number, running: number, done: number, failed: number, cancelled: number, total: number}} counts.
   */
  function counts() {
    const result = { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: state.tasks.length }
    for (const task of state.tasks) {
      if (Object.hasOwn(result, task.status)) result[task.status] += 1
    }
    return result
  }

  load()

  return {
    dataFile,
    get migratedFrom() {
      return migratedFrom
    },
    createTask,
    updateTask,
    markRunNow,
    cancelQueued,
    retryTask,
    removeTask,
    moveTask,
    startRun,
    setRunBaseline,
    finishRun,
    recordRun,
    incrementZeroCallCreations,
    listRuns,
    getLifetime,
    armSession,
    getArmed,
    listArmed,
    setArmError,
    disarmSession,
    pruneArms,
    getSettings,
    setSettings,
    listTasks,
    listQueued,
    getTask,
    counts,
    flush,
    dispose() {
      disposed = true
      try {
        flush()
      } catch (error) {
        warn(`offpeak-queue: 关闭时保存队列失败：${error instanceof Error ? error.message : String(error)}`)
      }
    },
  }
}

// Re-exported so callers can validate settings through the store module.
export { SettingsError, normalizeSettings }
