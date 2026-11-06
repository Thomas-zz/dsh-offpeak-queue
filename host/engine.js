/**
 * Queue scheduler for the off-peak queue (v2).
 *
 * A 15 s `setInterval` plus mutation-triggered passes start eligible queued
 * tasks while under `maxConcurrent` and either inside an off-peak billing
 * period or marked `forceRun`. Starts are serialized through one promise chain
 * so a task can never be picked twice, while the runs themselves overlap up to
 * the concurrency limit. Every settle appends one run-ledger entry, records the
 * task outcome, releases the slot, and drains the next one. Manual starts
 * (`POST /tasks/:id/start`, tool `run_now`/`run_current`) bypass the off-peak
 * gate but share the same run ledger and concurrency accounting.
 *
 * @module dsh-offpeak-queue/host/engine
 */

import { resolvePeriod } from './policy.js'
import { calendarSettingsFor } from './families.js'

/** Default scheduler interval. */
export const TICK_INTERVAL_MS = 15_000

/**
 * Create the scheduler.
 *
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   runner: ReturnType<typeof import('./runner.js').createRunner>,
 *   logger?: {warn: Function, info: Function},
 *   now?: () => number,
 *   tickIntervalMs?: number,
 *   setIntervalFn?: (callback: () => void, ms: number) => unknown,
 *   clearIntervalFn?: (handle: unknown) => void,
 *   onRunSettled?: (taskId: string) => void,
 * }} options - scheduler dependencies.
 * @returns {object} engine API.
 */
export function createEngine(options) {
  const store = options.store
  const runner = options.runner
  const logger = options.logger ?? console
  const now = options.now ?? (() => Date.now())
  const tickIntervalMs = options.tickIntervalMs ?? TICK_INTERVAL_MS
  const setIntervalFn = options.setIntervalFn ?? ((callback, ms) => setInterval(callback, ms))
  const clearIntervalFn = options.clearIntervalFn ?? ((handle) => clearInterval(handle))
  const onRunSettled = options.onRunSettled ?? (() => {})

  /** taskId → {handle: null|{cancel}, pendingCancel: boolean, settings: object, trigger: 'offpeak'|'manual', startedAt: number} */
  const runs = new Map()
  let timer = null
  let started = false
  let disposed = false
  let ticking = false
  let pendingTick = false
  let tickPromise = null
  let startChain = Promise.resolve()

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
   * Start the periodic scheduler and run one immediate pass.
   *
   * @returns {void}
   */
  function start() {
    if (started || disposed) return
    started = true
    timer = setIntervalFn(() => {
      void tick()
    }, tickIntervalMs)
    timer?.unref?.()
    void tick()
  }

  /**
   * Count in-flight runs (settled runs release their slot immediately).
   *
   * @returns {number} active run count.
   */
  function activeCount() {
    return runs.size
  }

  /**
   * Pick the next task a pass may start.
   *
   * `forceRun` tasks jump the queue and ignore both the off-peak check and the
   * `autoRun` master switch; normal tasks need `autoRun` and an off-peak
   * instant **of their own model family's calendar** (DeepSeek and GLM peak at
   * different hours), so a Tuesday-morning GLM task may start while a DeepSeek
   * task keeps waiting for its own off-peak window.
   *
   * @param {Function} periodOf - family id → current billing period (cached per pass).
   * @param {object} settings - effective settings.
   * @returns {object|undefined} queued task to start.
   */
  function pickCandidate(periodOf, settings) {
    // A task being edited from its conversation is paused: the edit must land
    // before the scheduler can start it.
    const editing = new Set(
      store
        .listArmed()
        .filter((arm) => arm.mode === 'update' && typeof arm.taskId === 'string')
        .map((arm) => arm.taskId),
    )
    const queued = store.listQueued().filter((task) => !editing.has(task.id))
    const forced = queued
      .filter((task) => task.forceRun)
      .sort((left, right) => left.createdAt - right.createdAt || left.order - right.order)
    if (forced.length > 0) return forced[0]
    if (!settings.autoRun) return undefined
    return queued.find((task) => !task.forceRun && periodOf(task.modelFamily).kind === 'offpeak')
  }

  /**
   * Run one scheduler pass, respecting the concurrency budget.
   *
   * @returns {Promise<void>} resolves when every start of this pass was launched.
   */
  async function pass() {
    if (disposed) return
    const settings = store.getSettings()
    const stamp = now()
    const calendarCache = new Map()
    const periodOf = (familyId) => {
      const known = calendarCache.get(familyId)
      if (known !== undefined) return known
      const period = resolvePeriod(stamp, calendarSettingsFor(familyId, settings))
      calendarCache.set(familyId, period)
      return period
    }
    while (!disposed) {
      const budget = settings.maxConcurrent - runs.size
      if (budget <= 0) return
      const candidate = pickCandidate(periodOf, settings)
      if (candidate === undefined) return
      await launch(candidate, 'offpeak', settings)
    }
  }

  /**
   * Claim a task in the store and launch its run through the serialized chain.
   *
   * @param {object} candidate - queued task snapshot.
   * @param {'offpeak'|'manual'} trigger - why it starts.
   * @param {object} settings - effective settings.
   * @param {{waitForIdle?: boolean}} [runOptions] - runtime options forwarded to the runner.
   * @returns {Promise<object|null>} claimed task once the run is in flight.
   */
  async function launch(candidate, trigger, settings, runOptions = {}) {
    const claimed = store.startRun(candidate.id, trigger)
    if (claimed === null) return null
    runs.set(claimed.id, { handle: null, pendingCancel: false, settings, trigger, startedAt: claimed.startedAt ?? now() })
    const job = startChain.then(() => launchRun(claimed, settings, trigger, runOptions))
    startChain = job.catch(() => {})
    await job
    return claimed
  }

  /**
   * Manually start one queued task now, bypassing the off-peak gate.
   *
   * @param {string} taskId - task id.
   * @returns {Promise<object|null>} the task after the start attempt (may be failed).
   */
  async function startTask(taskId, trigger = 'manual', runOptions = {}) {
    if (disposed) return null
    const task = store.getTask(taskId)
    if (task === null) return null
    await launch(task, trigger, store.getSettings(), runOptions)
    return store.getTask(taskId)
  }

  /**
   * Create the session prompt and send it for one claimed run.
   *
   * @param {object} task - claimed running task.
   * @param {object} settings - effective settings.
   * @param {'offpeak'|'manual'} trigger - why it starts.
   * @param {{waitForIdle?: boolean}} [runOptions] - runtime options forwarded to the runner.
   * @returns {Promise<void>} resolves once the run handle exists.
   */
  async function launchRun(task, settings, trigger, runOptions = {}) {
    const run = runs.get(task.id)
    if (run === undefined || disposed) return
    let handle
    try {
      handle = await runner.start(task, settings, { trigger, ...runOptions })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (run.pendingCancel) {
        settle(task.id, { kind: 'cancelled', turnEndKind: 'aborted', error: null })
      } else {
        settle(task.id, { kind: 'failed', turnEndKind: 'error', error: message })
      }
      return
    }
    const current = runs.get(task.id)
    if (current === undefined || disposed) {
      try {
        handle.cancel()
      } catch {
        /* ignored */
      }
      return
    }
    current.handle = handle
    if (typeof handle.baseline === 'number') store.setRunBaseline(task.id, handle.baseline)
    if (current.pendingCancel) handle.cancel()
    handle.settled.then((outcome) => settle(task.id, outcome), (error) => {
      settle(task.id, {
        kind: 'failed',
        turnEndKind: 'error',
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  /**
   * Build the run-ledger record for one settled run.
   *
   * @param {object} task - current task snapshot.
   * @param {object} run - in-memory run bookkeeping.
   * @param {object} outcome - runner outcome.
   * @param {object} patch - task outcome fields.
   * @returns {object} ledger record.
   */
  function ledgerRecord(task, run, outcome, patch) {
    return {
      taskId: task.id,
      sessionId: task.sourceSessionId,
      title: task.title,
      modelFamily: task.modelFamily,
      model: outcome.model ?? null,
      provider: outcome.provider ?? null,
      trigger: run.trigger,
      startedAt: run.startedAt,
      finishedAt: now(),
      status: patch.status,
      steps: patch.steps ?? [],
      usage: patch.usage ?? null,
      cost: patch.cost ?? null,
      peakCost: typeof outcome.peakCost === 'number' ? outcome.peakCost : null,
      saved: patch.saved ?? null,
      peakExtra: patch.peakExtra ?? null,
      points: typeof outcome.points === 'number' ? outcome.points : null,
      pointsSaved: typeof outcome.pointsSaved === 'number' ? outcome.pointsSaved : null,
      unpriced: outcome.unpriced === true,
    }
  }

  /**
   * Record one settled run: ledger entry, task outcome, guidance disposal, and
   * an immediate refill of the concurrency slot.
   *
   * @param {string} taskId - settled task id.
   * @param {object} outcome - runner outcome.
   * @returns {void}
   */
  function settle(taskId, outcome) {
    const run = runs.get(taskId)
    if (run === undefined) return
    runs.delete(taskId)
    try {
      const patch = outcomeToPatch(outcome)
      const task = store.getTask(taskId)
      if (task !== null) {
        try {
          store.recordRun(ledgerRecord(task, run, outcome, patch))
        } catch (error) {
          warn(`offpeak-queue: 记录运行明细失败：${error instanceof Error ? error.message : String(error)}`)
        }
        store.finishRun(taskId, patch)
      }
      try {
        onRunSettled(taskId)
      } catch (error) {
        warn(`offpeak-queue: 清理任务指引失败：${error instanceof Error ? error.message : String(error)}`)
      }
    } catch (error) {
      warn(`offpeak-queue: 记录任务结果失败：${error instanceof Error ? error.message : String(error)}`)
    }
    if (!disposed) void tick()
  }

  /**
   * Map one runner outcome to persisted task fields.
   *
   * @param {object} outcome - runner outcome.
   * @returns {object} store.finishRun patch.
   */
  function outcomeToPatch(outcome) {
    const base = {
      turnEndKind: outcome.turnEndKind ?? null,
      error: outcome.error ?? null,
      resultSnippet: outcome.resultSnippet ?? null,
      usage: outcome.usage ?? null,
      cost: typeof outcome.cost === 'number' ? outcome.cost : null,
      saved: typeof outcome.saved === 'number' ? outcome.saved : null,
      peakExtra: typeof outcome.peakExtra === 'number' ? outcome.peakExtra : null,
      points: typeof outcome.points === 'number' ? outcome.points : null,
      pointsSaved: typeof outcome.pointsSaved === 'number' ? outcome.pointsSaved : null,
      steps: Array.isArray(outcome.steps) ? outcome.steps : [],
    }
    if (outcome.kind === 'done') return { ...base, status: 'done', error: null }
    if (outcome.kind === 'cancelled') return { ...base, status: 'cancelled', error: null }
    return { ...base, status: 'failed' }
  }

  /**
   * Run one scheduler pass; concurrent calls coalesce into one follow-up pass.
   *
   * @returns {Promise<void>} resolves after the pass (and any coalesced pass) finished launching.
   */
  function tick() {
    if (disposed) return Promise.resolve()
    if (ticking) {
      pendingTick = true
      return tickPromise ?? Promise.resolve()
    }
    ticking = true
    tickPromise = (async () => {
      try {
        do {
          pendingTick = false
          await pass()
        } while (pendingTick && !disposed)
      } catch (error) {
        warn(`offpeak-queue: 调度器执行失败：${error instanceof Error ? error.message : String(error)}`)
      } finally {
        ticking = false
        tickPromise = null
      }
    })()
    return tickPromise
  }

  /**
   * Request cancellation of one in-flight run (also handles a run still
   * sending its execution prompt).
   *
   * @param {string} taskId - task id.
   * @returns {boolean} whether the task had an in-flight run.
   */
  function cancelTask(taskId) {
    const run = runs.get(taskId)
    if (run === undefined) return false
    run.pendingCancel = true
    if (run.handle !== null) run.handle.cancel()
    return true
  }

  /**
   * Stop the scheduler, cancel in-flight turns, and mark their tasks failed
   * (the store flush keeps the state consistent for the next boot).
   *
   * @returns {Promise<void>} resolves when cleanup finished.
   */
  async function dispose() {
    if (disposed) return
    disposed = true
    if (timer !== null) {
      clearIntervalFn(timer)
      timer = null
    }
    const pending = [...runs.entries()]
    for (const [taskId, run] of pending) {
      runs.delete(taskId)
      try {
        run.handle?.cancel()
      } catch {
        /* ignored */
      }
      try {
        const task = store.getTask(taskId)
        if (task !== null && task.status === 'running') {
          const outcome = { kind: 'failed', turnEndKind: 'interrupted', error: '插件卸载或 DSH 退出，执行中断' }
          store.recordRun(ledgerRecord(task, run, outcome, outcomeToPatch(outcome)))
          store.finishRun(taskId, outcomeToPatch(outcome))
          try {
            onRunSettled(taskId)
          } catch {
            /* ignored */
          }
        }
      } catch (error) {
        warn(`offpeak-queue: 卸载时记录任务状态失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    await startChain.catch(() => {})
  }

  return { start, tickNow: tick, activeCount, cancelTask, startTask, dispose, tickIntervalMs }
}
