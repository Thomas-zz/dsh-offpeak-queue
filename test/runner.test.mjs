/**
 * Unit tests for the in-conversation runner (`host/runner.js`).
 *
 * A fake Host context records wake admission and cancellation and replays
 * durable `session/event` frames by hand, so no real session or model call
 * happens. Focus: execution-turn attribution (including the real log ordering
 * where `turn/start` precedes the claimed `user/message`), per-step pricing
 * (including a cross-peak split), timeout/cancel handling, and the idle wait
 * that makes a wake message sent right after a blocked creation turn receivable.
 */

import test from 'node:test'
import assert from 'node:assert/strict'

import { EXECUTION_MESSAGE, createRunner, executionMessageFor } from '../host/runner.js'
import { normalizeSettings } from '../host/policy.js'

/** Base settings. */
const SETTINGS = normalizeSettings({})

/** Off-peak instant: Tuesday 2026-11-03 13:00 Beijing. */
const OFFPEAK_AT = Date.parse('2026-11-03T13:00:00+08:00')

/** Peak instant: Tuesday 2026-11-03 10:00 Beijing. */
const PEAK_AT = Date.parse('2026-11-03T10:00:00+08:00')

/**
 * Silent logger that records warnings.
 *
 * @returns {{warn: Function, warnings: string[]}} logger stub.
 */
function captureLogger() {
  const warnings = []
  return {
    warnings,
    warn(message) {
      warnings.push(String(message))
    },
    info() {},
  }
}

/**
 * Build a fake Host context.
 *
 * @param {{archived?: boolean, liveSeq?: number|null, status?: 'idle'|'running', whenIdle?: Function, resolveError?: Error}} [options] - fake behaviours.
 * @returns {object} fake context.
 */
function fakeCtx(options = {}) {
  const listeners = new Set()
  const wakeState = { listenerCountAtWake: -1 }
  const messages = []
  const sessionController = {
    cancelled: [],
    async resolveAgent() {
      if (options.resolveError !== undefined) throw options.resolveError
      return { agent }
    },
    async cancel(request) {
      this.cancelled.push(request)
      return { accepted: true }
    },
  }
  const liveSession = options.liveSeq === null || options.liveSeq === undefined ? undefined : { seq: options.liveSeq }
  const agent = {
    status: options.status ?? 'idle',
    session: {},
    whenIdle: options.whenIdle ?? (async () => {}),
    followup(message) {
      messages.push(message)
      wakeState.listenerCountAtWake = listeners.size
    },
  }
  const ctx = {
    listeners,
    wakeState,
    messages,
    sessionController,
    sessions: {
      flushed: 0,
      get: (id) => (id === 'session-source' ? liveSession : undefined),
      async flush() {
        this.flushed += 1
        return true
      },
    },
    get(name) {
      if (name === 'agents') return { get: () => agent }
      if (name === 'workspaceRegistry') return { archivedSessionIds: options.archived === true ? ['session-source'] : [] }
      return undefined
    },
    on(name, callback) {
      listeners.add(callback)
      return () => listeners.delete(callback)
    },
    listenerCount() {
      return listeners.size
    },
  }
  let seq = 9
  /**
   * Replay one durable session event.
   *
   * @param {string} sessionId - subject session id.
   * @param {string} type - event type.
   * @param {object} data - event data.
   * @param {object} [extra] - extra event fields (e.g. time).
   * @returns {object} emitted event.
   */
  ctx.emit = (sessionId, type, data, extra = {}) => {
    seq += 1
    const event = { type, seq, time: extra.time ?? OFFPEAK_AT, data }
    for (const callback of [...listeners]) callback({ id: sessionId }, event)
    return event
  }
  return ctx
}

/**
 * Build one queued task bound to the fake source conversation.
 *
 * @param {object} [overrides] - task overrides.
 * @returns {object} task.
 */
function makeTask(overrides = {}) {
  return {
    id: 't-1793682916697-abcd',
    title: '整理书稿目录',
    prompt: '请整理书稿目录',
    sourceSessionId: 'session-source',
    sessionId: 'session-source',
    status: 'running',
    runTrigger: 'offpeak',
    ...overrides,
  }
}

/**
 * Build a runner over the fake context.
 *
 * @param {object} ctx - fake context.
 * @param {object} [options] - runner overrides.
 * @returns {object} runner.
 */
function makeRunner(ctx, options = {}) {
  return createRunner({
    ctx,
    logger: captureLogger(),
    timeoutMsFor: () => 60_000,
    ...options,
  })
}

/**
 * Emit the durable frames of one completed execution turn.
 *
 * @param {object} ctx - fake context.
 * @param {object} handle - runner handle.
 * @param {object} [options] - message plan.
 * @returns {void}
 */
function playCompletedTurn(ctx, handle, options = {}) {
  const turn = options.turn ?? 2
  const sessionId = handle.sessionId
  ctx.emit(sessionId, 'turn/start', { turn })
  ctx.emit(sessionId, 'user/message', {
    id: handle.requestId,
    content: [{ type: 'text', text: EXECUTION_MESSAGE.offpeak }],
    source: { kind: 'cordis-host-runner' },
    role: 'user',
  })
  const messages = options.messages ?? [
    { text: '收到啦', usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 } },
  ]
  for (const [index, message] of messages.entries()) {
    ctx.emit(sessionId, 'assistant/message', {
      turn,
      step: index + 1,
      message: { role: 'assistant', content: [{ type: 'text', text: message.text }], source: { provider: message.provider ?? 'deepseek-account', model: message.model ?? 'deepseek-flash' } },
      usage: message.usage,
    }, { time: message.at ?? OFFPEAK_AT })
  }
  ctx.emit(sessionId, 'turn/end', { turn, reason: options.reason ?? { kind: 'completed' } })
}

test('start wakes the source conversation and registers the watcher before waking', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' })
  assert.equal(handle.sessionId, 'session-source')
  assert.equal(handle.baseline, 9, 'baseline is the live session sequence before waking')
  assert.equal(ctx.wakeState.listenerCountAtWake, 1, 'watcher is live before the wake message is admitted')
  assert.equal(ctx.messages.length, 1)
  const message = ctx.messages[0]
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, 'cordis-host-runner', 'the wake renders as a trigger card, not a user bubble')
  assert.deepEqual(message.content, [{ type: 'text', text: `${EXECUTION_MESSAGE.offpeak}\n\n请整理书稿目录` }], 'the instruction carries the task text, which the transcript does not hold')
  assert.equal(message.id, handle.requestId)
  assert.equal(ctx.sessions.flushed, 1, 'the wake message is flushed to persistence')
})

test('waits for a busy conversation to be idle before admitting the wake message', async () => {
  let releaseIdle
  const idle = new Promise((resolve) => {
    releaseIdle = resolve
  })
  let resolved = false
  const ctx = fakeCtx({ liveSeq: 9, status: 'running', whenIdle: () => idle })
  const runner = makeRunner(ctx)
  const starting = runner.start(makeTask(), SETTINGS, { trigger: 'manual' }).then((handle) => {
    resolved = true
    return handle
  })
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(resolved, false, 'start waits for idle')
  assert.equal(ctx.messages.length, 0)
  releaseIdle()
  const handle = await starting
  assert.equal(ctx.messages.length, 1)
  assert.equal(handle.sessionId, 'session-source')
})

test('waitForIdle:false admits the wake without waiting for the open turn (run_current path)', async () => {
  let idleCalled = false
  const ctx = fakeCtx({ liveSeq: 9, status: 'running', whenIdle: async () => { idleCalled = true } })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'manual', waitForIdle: false })
  assert.equal(idleCalled, false, 'a wake queued from inside the same turn must not wait for idle')
  assert.equal(ctx.messages.length, 1)
  playCompletedTurn(ctx, handle, { turn: 2 })
  assert.equal((await handle.settled).kind, 'done')
})

test('attributes the execution turn from durable ordering (turn/start before the user message)', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' })

  // Real ordering for an idle conversation: the loop opens the turn first.
  ctx.emit('session-source', 'turn/start', { turn: 2 })
  ctx.emit('session-source', 'user/message', {
    id: handle.requestId,
    content: [{ type: 'text', text: EXECUTION_MESSAGE.offpeak }],
    source: { kind: 'cordis-host-runner' },
    role: 'user',
  })
  ctx.emit('session-source', 'assistant/message', {
    turn: 2,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '收到啦' }], source: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0 },
  }, { time: OFFPEAK_AT })
  ctx.emit('session-source', 'turn/end', { turn: 2, reason: { kind: 'completed' } })

  const outcome = await handle.settled
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.turnEndKind, 'completed')
  assert.equal(outcome.sessionId, 'session-source')
  assert.equal(outcome.resultSnippet, '收到啦')
  assert.equal(outcome.steps.length, 1)
  assert.equal(outcome.steps[0].tier, 'offpeak')
  assert.equal(outcome.provider, 'deepseek-account')
  assert.equal(outcome.model, 'deepseek-flash')
  assert.deepEqual(outcome.usage, { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 })
  // costPeak = (1000*2 + 0*0.04 + 100*8)/1e6 = 0.0028; off-peak half = 0.0014
  assert.equal(Math.round(outcome.peakCost * 1e6) / 1e6, 0.0028)
  assert.equal(Math.round(outcome.cost * 1e6) / 1e6, 0.0014)
  assert.equal(Math.round(outcome.saved * 1e6) / 1e6, 0.0014)
  assert.equal(outcome.peakExtra, 0)
  assert.equal(outcome.unpriced, false)
  assert.equal(ctx.listenerCount(), 0, 'watcher detached after settling')
})

test('ignores a still-running previous turn and settles on the execution turn', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'manual' })
  // The user's own turn was already open before the execution wake.
  ctx.emit('session-source', 'turn/start', { turn: 2 })
  ctx.emit('session-source', 'assistant/message', {
    turn: 2,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '用户自己的回复' }], source: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage: { inputTokens: 1, outputTokens: 1 },
  }, { time: OFFPEAK_AT })
  // The execution wake waits for the next-turn boundary: its turn opens
  // first, then the claimed message is appended inside that turn's first step.
  ctx.emit('session-source', 'turn/start', { turn: 3 })
  ctx.emit('session-source', 'user/message', {
    id: handle.requestId,
    content: [{ type: 'text', text: EXECUTION_MESSAGE.manual }],
    source: { kind: 'cordis-host-runner' },
    role: 'user',
  })
  ctx.emit('session-source', 'assistant/message', {
    turn: 3,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '执行结果' }], source: { provider: 'deepseek-account', model: 'deepseek-flash' } },
    usage: { inputTokens: 2000, outputTokens: 200 },
  }, { time: OFFPEAK_AT })
  ctx.emit('session-source', 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  ctx.emit('session-source', 'turn/end', { turn: 3, reason: { kind: 'completed' } })

  const outcome = await handle.settled
  assert.equal(outcome.kind, 'done')
  assert.equal(outcome.steps.length, 1, 'only the execution turn contributes steps')
  assert.equal(outcome.steps[0].usage.inputTokens, 2000)
  assert.equal(outcome.resultSnippet, '执行结果')
})

test('a peak window prices steps at full price with peakExtra', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'manual' })
  playCompletedTurn(ctx, handle, {
    messages: [{ text: '高峰回复', usage: { inputTokens: 1000, outputTokens: 100 }, at: PEAK_AT }],
  })
  const outcome = await handle.settled
  assert.equal(outcome.steps[0].tier, 'peak')
  assert.equal(Math.round(outcome.cost * 1e6) / 1e6, 0.0028)
  assert.equal(outcome.saved, 0)
  assert.equal(Math.round(outcome.peakExtra * 1e6) / 1e6, 0.0014)
})

test('a cross-peak run splits cost, saved, and peakExtra per step', async () => {
  const settings = normalizeSettings({ peakWindows: [{ weekdays: [2], start: '14:00', end: '18:00' }] }, SETTINGS)
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const task = makeTask({ runTrigger: 'manual' })
  const handle = await runner.start(task, settings, { trigger: 'manual' })
  const before = Date.parse('2026-11-03T13:58:00+08:00')
  const after = Date.parse('2026-11-03T14:01:00+08:00')
  playCompletedTurn(ctx, handle, {
    messages: [
      { text: '跨峰前', usage: { inputTokens: 1000, outputTokens: 100 }, at: before },
      { text: '跨峰后', usage: { inputTokens: 1000, outputTokens: 100 }, at: after },
    ],
  })
  const outcome = await handle.settled
  assert.deepEqual(outcome.steps.map((step) => step.tier), ['offpeak', 'peak'])
  assert.equal(Math.round(outcome.peakCost * 1e6) / 1e6, 0.0056)
  assert.equal(Math.round(outcome.cost * 1e6) / 1e6, 0.0042)
  assert.equal(Math.round(outcome.saved * 1e6) / 1e6, 0.0014)
  assert.equal(Math.round(outcome.peakExtra * 1e6) / 1e6, 0.0014)
})

test('turn/end error surfaces the model failure and keeps partial steps', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' })
  playCompletedTurn(ctx, handle, {
    messages: [{ text: '部分输出', usage: { inputTokens: 100, outputTokens: 10 }, at: OFFPEAK_AT }],
    reason: { kind: 'error', error: { message: 'authentication failed', code: 'AUTH' } },
  })
  const outcome = await handle.settled
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.turnEndKind, 'error')
  assert.match(outcome.error, /authentication failed/)
  assert.match(outcome.error, /AUTH/)
  assert.equal(outcome.steps.length, 1)
  assert.equal(outcome.resultSnippet, '部分输出')
})

test('max-tokens fails; aborted without our cancel is cancelled; blocked fails', async () => {
  for (const [reason, expected] of [
    [{ kind: 'max-tokens' }, { kind: 'failed', turnEndKind: 'max-tokens' }],
    [{ kind: 'aborted' }, { kind: 'cancelled', turnEndKind: 'aborted' }],
    [{ kind: 'blocked' }, { kind: 'failed', turnEndKind: 'blocked' }],
  ]) {
    const ctx = fakeCtx({ liveSeq: 9 })
    const runner = makeRunner(ctx)
    const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' })
    playCompletedTurn(ctx, handle, { reason })
    const outcome = await handle.settled
    assert.equal(outcome.kind, expected.kind, JSON.stringify(reason))
    assert.equal(outcome.turnEndKind, expected.turnEndKind, JSON.stringify(reason))
    if (expected.kind === 'failed') assert.ok(typeof outcome.error === 'string' && outcome.error.length > 0)
  }
})

test('an archived source conversation fails with a readable reason', async () => {
  const ctx = fakeCtx({ archived: true, liveSeq: 9 })
  const runner = makeRunner(ctx)
  await assert.rejects(
    () => runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' }),
    /来源对话已归档/,
  )
  assert.equal(ctx.messages.length, 0)
})

test('a wake admission failure fails with a readable reason and detaches the watcher', async () => {
  const ctx = fakeCtx({ liveSeq: 9, resolveError: new Error('session disappeared') })
  const runner = makeRunner(ctx)
  await assert.rejects(
    () => runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' }),
    /来源对话不可用，无法执行/,
  )
  assert.equal(ctx.listenerCount(), 0)
})

test('timeout cancels the conversation and settles as failed with the timeout error', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx, { timeoutMsFor: () => 25 })
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' })
  const outcome = await handle.settled
  assert.equal(outcome.kind, 'timeout')
  assert.equal(outcome.turnEndKind, 'timeout')
  assert.match(outcome.error, /超时（>120 分钟）/)
  assert.deepEqual(ctx.sessionController.cancelled, [{ sessionId: 'session-source' }])
  assert.equal(ctx.listenerCount(), 0)
})

test('cancel requests the turn cancel and settles cancelled on the aborted turn', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'manual' })
  ctx.emit('session-source', 'turn/start', { turn: 2 })
  ctx.emit('session-source', 'user/message', {
    id: handle.requestId,
    content: [{ type: 'text', text: EXECUTION_MESSAGE.manual }],
    source: { kind: 'cordis-host-runner' },
    role: 'user',
  })
  handle.cancel()
  assert.deepEqual(ctx.sessionController.cancelled, [{ sessionId: 'session-source' }])
  ctx.emit('session-source', 'turn/end', { turn: 2, reason: { kind: 'aborted' } })
  const outcome = await handle.settled
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(outcome.turnEndKind, 'aborted')
  assert.equal(ctx.listenerCount(), 0)
})

test('cancel settles during the grace window when no turn/end arrives', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx, { cancelGraceMs: 20 })
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'manual' })
  handle.cancel()
  const outcome = await handle.settled
  assert.equal(outcome.kind, 'cancelled')
  assert.equal(ctx.listenerCount(), 0)
})

test('the start guard fails a wake whose turn never begins instead of hanging', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx, { startGuardMs: 25 })
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' })
  // No user/message and no turn/start are ever replayed.
  const outcome = await handle.settled
  assert.equal(outcome.kind, 'failed')
  assert.equal(outcome.turnEndKind, 'error')
  assert.match(outcome.error, /对话未能开始执行/)
})

test('a cold (not live) source conversation can still be woken', async () => {
  const ctx = fakeCtx({ liveSeq: null })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'manual' })
  assert.equal(handle.baseline, null)
  playCompletedTurn(ctx, handle)
  assert.equal((await handle.settled).kind, 'done')
})

test('executionMessageFor replays the stored task content after the instruction', () => {
  const image = { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 10, height: 20, bytes: 30, name: 'image.png' } }
  const message = executionMessageFor(
    { prompt: '看看这个 UI\n第二行', content: [{ type: 'text', text: '看看这个 UI' }, image] },
    'offpeak',
    'm-1',
  )
  assert.equal(message.id, 'm-1')
  assert.deepEqual(message.content, [{ type: 'text', text: `${EXECUTION_MESSAGE.offpeak}\n\n看看这个 UI\n第二行` }, image])
  assert.equal(message.source.kind, 'cordis-host-runner')

  const bare = executionMessageFor({ prompt: '   ' }, 'manual', 'm-2')
  assert.deepEqual(bare.content, [{ type: 'text', text: EXECUTION_MESSAGE.manual }])
})

// ────────────────────────────────────────────────────────────────────────────
// Model-family step pricing: the tier follows the serving model's calendar
// ────────────────────────────────────────────────────────────────────────────

test('a GLM step is tiered by the GLM calendar and carries estimated credits', async () => {
  // Tuesday 10:00 Beijing is inside DeepSeek's morning peak but off-peak for
  // GLM (14:00–18:00), so the same instant must tier differently per family.
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask({ modelFamily: 'glm' }), SETTINGS, { trigger: 'offpeak' })
  playCompletedTurn(ctx, handle, {
    messages: [
      { text: '好的', usage: { inputTokens: 10000, outputTokens: 2000 }, provider: 'zai-coding-cn', model: 'glm-5.3', at: PEAK_AT },
    ],
  })
  const outcome = await handle.settled
  assert.equal(outcome.unpriced, true, 'GLM has no CNY price entry')
  const step = outcome.steps[0]
  assert.equal(step.tier, 'offpeak', 'the GLM calendar decides the tier, not the DeepSeek one')
  // (10000*6.9 + 2000*24)/10000 = 11.7 base credits → 5.85 at the half rate.
  assert.equal(step.points, 5.85)
  assert.equal(step.pointsSaved, 5.85)
  assert.equal(outcome.points, 5.85)
  assert.equal(outcome.pointsSaved, 5.85)
})

test('a DeepSeek step at the same instant stays peak and carries no credits', async () => {
  const ctx = fakeCtx({ liveSeq: 9 })
  const runner = makeRunner(ctx)
  const handle = await runner.start(makeTask(), SETTINGS, { trigger: 'offpeak' })
  playCompletedTurn(ctx, handle, {
    messages: [
      { text: '收到', usage: { inputTokens: 1000, outputTokens: 100 }, provider: 'deepseek-account', model: 'deepseek-flash', at: PEAK_AT },
    ],
  })
  const outcome = await handle.settled
  assert.equal(outcome.steps[0].tier, 'peak')
  assert.equal(outcome.steps[0].points, null)
  assert.equal(outcome.points, null)
})
