/**
 * In-conversation execution of one queued off-peak task.
 *
 * A run never creates a session: it wakes the task's source conversation with a
 * short plugin-trigger message (rendered by the chat as a trigger card, not as a
 * human message), locates that durable `user/message` by its id, collects the
 * `assistant/message` steps of the following turn (usage + completion time for
 * tiered pricing), and settles at that turn's `turn/end` (or timeout / cancel).
 * Costs are computed per step from the step's completion instant.
 *
 * @module @zayn_/dsh-offpeak-queue/host/runner
 */

import { randomUUID } from 'node:crypto'
import { resolvePeriod } from './policy.js'
import { normalizeUsage, stepCost, stepPoints, sumRunCost } from './pricing.js'
import { calendarSettingsFor, classifySelection } from './families.js'

/** Source family of the execution wake message (chat renders a trigger card). */
const EXECUTION_SOURCE = 'cordis-host-runner'

/** Short execution messages sent into the source conversation. */
export const EXECUTION_MESSAGE = Object.freeze({
  offpeak: '闲时任务到期，开始执行下面的任务。',
  manual: '现在开始执行下面的任务。',
})

/**
 * Build the durable execution message for one task.
 *
 * A queued task's creation message never enters the session log (the rejected
 * creation step cannot write one, and a plugin write would corrupt the log), so
 * the execution message carries the task content itself: the instruction, the
 * full prompt text, and every attachment the user pasted when queuing it. The
 * chat renders it as a trigger card, never as a human bubble.
 *
 * @param {object} task - queued task.
 * @param {'offpeak'|'manual'} trigger - why the run starts.
 * @param {string} id - durable message id.
 * @returns {{id: string, role: string, content: object[], source: {kind: string}}} user message.
 */
export function executionMessageFor(task, trigger, id) {
  const instruction = EXECUTION_MESSAGE[trigger] ?? EXECUTION_MESSAGE.manual
  const prompt = typeof task?.prompt === 'string' ? task.prompt.trim() : ''
  const content = [{ type: 'text', text: prompt === '' ? instruction : `${instruction}\n\n${prompt}` }]
  for (const block of Array.isArray(task?.content) ? task.content : []) {
    if (block?.type === 'image' || block?.type === 'file') content.push(block)
  }
  return {
    id,
    role: 'user',
    content,
    source: { kind: EXECUTION_SOURCE },
  }
}

/** Grace period after a cancel request before the run settles as cancelled. */
const CANCEL_GRACE_MS = 10_000

/** Maximum length of a surfaced failure message. */
const MAX_ERROR_LENGTH = 400

/** Steps kept on a task / run record. */
const MAX_STEPS = 200

/**
 * Best-effort extraction of a durable turn-end failure message.
 *
 * @param {object|undefined} reason - `turn/end` reason object.
 * @returns {string} human-readable failure text.
 */
function failureMessage(reason) {
  const failure = reason?.error
  const message = failure?.message
    ?? failure?.failure?.message
    ?? failure?.code
    ?? '模型调用失败'
  const code = typeof failure?.code === 'string' ? failure.code : ''
  const text = String(message)
  return (code !== '' && !text.includes(code) ? `${text}（${code}）` : text).slice(0, MAX_ERROR_LENGTH)
}

/**
 * Map a durable `turn/end` reason to a queue outcome.
 *
 * @param {object|undefined} reason - `turn/end` reason object.
 * @returns {{kind: 'done'|'failed'|'cancelled', turnEndKind: string, error?: string}} outcome.
 */
export function outcomeFromReason(reason) {
  const kind = typeof reason?.kind === 'string' ? reason.kind : 'error'
  switch (kind) {
    case 'completed':
      return { kind: 'done', turnEndKind: 'completed' }
    case 'max-tokens':
      return { kind: 'failed', turnEndKind: 'max-tokens', error: '输出长度超限（max-tokens），本次执行未完成' }
    case 'error':
      return { kind: 'failed', turnEndKind: 'error', error: failureMessage(reason) }
    case 'blocked':
      return { kind: 'failed', turnEndKind: 'blocked', error: '执行被阻止（blocked）' }
    case 'interrupted':
      return { kind: 'failed', turnEndKind: 'interrupted', error: '执行被中断（interrupted）' }
    case 'aborted':
    case 'forked':
      return { kind: 'cancelled', turnEndKind: kind }
    default:
      return { kind: 'failed', turnEndKind: kind, error: `未知的结束原因：${kind}` }
  }
}

/**
 * Join the text blocks of one assistant message.
 *
 * @param {object|undefined} message - assistant message.
 * @returns {string} concatenated text.
 */
function assistantText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  let text = ''
  for (const block of content) {
    if (block?.type === 'text' && typeof block.text === 'string') text += block.text
  }
  return text
}

/**
 * Whether the workspace registry marks a session as archived.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host context.
 * @param {string} sessionId - session id.
 * @returns {boolean} true when archived.
 */
function isArchivedSession(ctx, sessionId) {
  try {
    const registry = ctx.get('workspaceRegistry')
    const archived = registry?.archivedSessionIds
    return Array.isArray(archived) && archived.includes(sessionId)
  } catch {
    return false
  }
}

/**
 * Create the in-conversation session runner.
 *
 * @param {{
 *   ctx: import('@deepseek-ai/cordis').Context,
 *   logger?: {warn: Function, info: Function},
 *   timeoutMsFor?: (settings: object) => number,
 *   cancelGraceMs?: number,
 * }} options - runner dependencies.
 * @returns {{start: (task: object, settings: object, run: {trigger: 'offpeak'|'manual'}) => Promise<{sessionId: string, baseline: number|null, settled: Promise<object>, cancel: () => void}>}} runner API.
 */
export function createRunner(options) {
  const { ctx } = options
  const logger = options.logger ?? console
  const timeoutMsFor = options.timeoutMsFor
    ?? ((settings) => Math.max(60_000, Math.round(settings.taskTimeoutMinutes * 60_000)))
  const cancelGraceMs = options.cancelGraceMs ?? CANCEL_GRACE_MS

  /**
   * Log a warning without ever breaking the run.
   *
   * @param {string} message - text to log.
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
   * Start one run in the task's source conversation.
   *
   * @param {object} task - queued task (already claimed as running).
   * @param {object} settings - effective settings snapshot at start.
   * @param {{trigger: 'offpeak'|'manual', waitForIdle?: boolean}} run - why the run
   *   starts and whether to wait for a busy conversation to settle first.
   * @returns {Promise<object>} run handle.
   */
  async function start(task, settings, run) {
    const sessionId = task.sourceSessionId
    if (typeof sessionId !== 'string' || sessionId === '') {
      throw new Error('来源对话不可用，无法执行')
    }
    if (isArchivedSession(ctx, sessionId)) {
      throw new Error('来源对话已归档，无法执行')
    }
    const liveSession = ctx.sessions.get(sessionId)
    const baseline = typeof liveSession?.seq === 'number' ? liveSession.seq : null
    // The wake message is built here (not by sessionController.prompt) so its
    // source is a plugin trigger: the chat shows a compact trigger card instead
    // of a user bubble attributed to the human. It also carries the task
    // content, which the transcript does not hold.
    const executionMessage = executionMessageFor(task, run.trigger, randomUUID())
    const requestId = executionMessage.id
    let settledResolved = false
    let cancelRequested = false
    let timedOut = false
    let lastText = ''
    let execUserSeq = null
    let execTurn = null
    /** Turn/start events seen while waiting for the execution turn, oldest first. */
    const turnStarts = []
    const steps = []
    let timeoutTimer = null
    let graceTimer = null
    let startGuardTimer = null
    const startGuardMs = options.startGuardMs ?? 60_000
    let detach = () => {}
    let resolveSettled
    const settled = new Promise((resolve) => {
      resolveSettled = resolve
    })

    /**
     * Resolve the run's single settled outcome and release every resource.
     *
     * @param {{kind: string, turnEndKind?: string, error?: string|null}} outcome - raw outcome.
     * @returns {void}
     */
    function finish(outcome) {
      if (settledResolved) return
      settledResolved = true
      detach()
      if (timeoutTimer !== null) clearTimeout(timeoutTimer)
      if (graceTimer !== null) clearTimeout(graceTimer)
      if (startGuardTimer !== null) clearTimeout(startGuardTimer)
      timeoutTimer = null
      graceTimer = null
      startGuardTimer = null
      const kind = timedOut ? 'timeout' : outcome.kind
      let lastProvider = null
      let lastModel = null
      for (let index = steps.length - 1; index >= 0; index -= 1) {
        if (steps[index].provider !== null || steps[index].model !== null) {
          lastProvider = steps[index].provider
          lastModel = steps[index].model
          break
        }
      }
      const totals = sumRunCost(steps)
      resolveSettled({
        kind,
        sessionId,
        turnEndKind: timedOut ? 'timeout' : outcome.turnEndKind ?? null,
        error: timedOut ? `超时（>${settings.taskTimeoutMinutes} 分钟）` : outcome.error ?? null,
        resultSnippet: lastText.trim() === '' ? null : lastText.trim().slice(0, 600),
        usage: totals.usage,
        cost: totals.cost,
        peakCost: totals.peakCost,
        saved: totals.saved,
        peakExtra: totals.peakExtra,
        points: totals.points,
        pointsSaved: totals.pointsSaved,
        unpriced: totals.unpriced,
        provider: lastProvider,
        model: lastModel,
        steps: steps.slice(-MAX_STEPS),
      })
    }

    // Watcher BEFORE the prompt so the execution user message can never be missed.
    //
    // Durable ordering note: when the conversation is idle the loop opens the
    // turn (`turn/start`) and only then writes the claimed `user/message` while
    // assembling the step, so the execution turn is the LAST `turn/start`
    // before the execution user message — not the first one after it.
    detach = ctx.on('session/event', (subject, event) => {
      if (subject?.id !== sessionId) return
      if (event.type === 'user/message') {
        if (execUserSeq === null && event.data?.id === executionMessage.id) {
          execUserSeq = event.seq
          for (const start of turnStarts) {
            if (start.seq < execUserSeq) execTurn = start.turn
          }
        }
        return
      }
      if (event.type === 'turn/start') {
        turnStarts.push({ turn: event.data?.turn, seq: event.seq })
        if (execTurn === null && execUserSeq !== null && event.seq > execUserSeq) execTurn = event.data?.turn
        return
      }
      if (execTurn === null || event.data?.turn !== execTurn) return
      if (event.type === 'assistant/message') {
        try {
          const text = assistantText(event.data?.message)
          if (text.trim() !== '') lastText = text
          if (event.data?.usage !== undefined && event.data.usage !== null) {
            const usage = normalizeUsage(event.data.usage)
            const provider = typeof event.data.message?.source?.provider === 'string' ? event.data.message.source.provider : null
            const model = typeof event.data.message?.source?.model === 'string' ? event.data.message.source.model : null
            // The billing tier follows the family of the model that actually
            // served this step (per its own calendar), not the task's family.
            const stepFamily = classifySelection(provider, model)
            const tier = resolvePeriod(event.time, calendarSettingsFor(stepFamily, settings)).kind
            const cost = stepCost({ tier, usage, provider, model, prices: settings.prices })
            const points = stepPoints({ tier, usage, provider, model })
            steps.push({
              at: event.time,
              tier,
              usage,
              cost: cost.cost,
              peakCost: cost.peakCost,
              saved: cost.saved,
              peakExtra: cost.peakExtra,
              points: points.points,
              pointsSaved: points.pointsSaved,
              provider,
              model,
            })
          }
        } catch (error) {
          warn(`offpeak-queue: 读取执行步骤失败：${error instanceof Error ? error.message : String(error)}`)
        }
        return
      }
      if (event.type === 'turn/end') finish(outcomeFromReason(event.data?.reason))
    })
    if (typeof detach !== 'function') detach = () => {}

    // A prompt queued into a turn that ends `blocked` (the creation-rejection
    // turn) never wakes its Agent, so wait for the conversation to be idle
    // before admitting the execution message. Runs against a busy conversation
    // simply start when its current activity settles.
    if (run.waitForIdle !== false) {
      try {
        const liveAgent = ctx.get('agents')?.get?.(sessionId)
        if (liveAgent !== undefined && liveAgent.status === 'running' && typeof liveAgent.whenIdle === 'function') {
          await liveAgent.whenIdle()
        }
      } catch (error) {
        warn(`offpeak-queue: 等待对话空闲失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }

    try {
      const resolved = await ctx.sessionController.resolveAgent(sessionId)
      if (resolved === undefined || resolved === null || 'error' in resolved) {
        throw resolved?.error ?? new Error('会话不存在或不可恢复')
      }
      const agent = resolved.agent
      if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
        throw new Error('来源对话不可用')
      }
      agent.followup(executionMessage)
      await ctx.sessions.flush(agent.session)
    } catch (error) {
      detach()
      const failure = new Error(`来源对话不可用，无法执行：${error instanceof Error ? error.message : String(error)}`)
      failure.code = 'SESSION_UNAVAILABLE'
      failure.cause = error
      throw failure
    }

    // Safety net: the wake message was admitted but the conversation never
    // started the execution turn while its Agent is idle — fail instead of
    // hanging for the whole timeout window. A busy Agent is left to the normal
    // timeout watchdog.
    startGuardTimer = setTimeout(() => {
      if (settledResolved || execUserSeq !== null) return
      try {
        const agent = ctx.get('agents')?.get?.(sessionId)
        if (agent !== undefined && agent.status === 'running') return
        finish({
          kind: 'failed',
          turnEndKind: 'error',
          error: '对话未能开始执行（可能正忙或尚未就绪），请稍后重试',
        })
      } catch {
        /* ignored */
      }
    }, startGuardMs)
    startGuardTimer.unref?.()

    const timeoutMs = timeoutMsFor(settings)
    timeoutTimer = setTimeout(() => {
      timedOut = true
      void Promise.resolve(ctx.sessionController.cancel({ sessionId })).catch((error) => {
        warn(`offpeak-queue: 超时取消会话失败：${error instanceof Error ? error.message : String(error)}`)
      })
      finish({ kind: 'timeout', turnEndKind: 'timeout' })
    }, timeoutMs)
    timeoutTimer.unref?.()

    /**
     * Request cancellation of the execution turn. Settles as cancelled if the
     * Agent never publishes a closing `turn/end`.
     *
     * @returns {void}
     */
    function cancel() {
      if (settledResolved || cancelRequested) return
      cancelRequested = true
      try {
        const pending = ctx.sessionController.cancel({ sessionId })
        if (pending !== undefined && typeof pending.catch === 'function') {
          pending.catch((error) => {
            warn(`offpeak-queue: 取消会话失败：${error instanceof Error ? error.message : String(error)}`)
          })
        }
      } catch (error) {
        warn(`offpeak-queue: 取消会话失败：${error instanceof Error ? error.message : String(error)}`)
      }
      if (graceTimer !== null) clearTimeout(graceTimer)
      graceTimer = setTimeout(() => finish({ kind: 'cancelled', turnEndKind: 'aborted' }), cancelGraceMs)
      graceTimer.unref?.()
    }

    return { sessionId, baseline, settled, cancel, requestId }
  }

  return { start }
}
