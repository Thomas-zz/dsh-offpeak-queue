/**
 * Unit tests for the v2 queue controller: arm/disarm validation, creation and
 * mutation operations, snapshot shape (armed + stats), and `/stats`
 * aggregation. The scheduler and Host services are stubs, so nothing creates
 * sessions or touches the network.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../host/store.js'
import { createController, ControllerError } from '../host/controller.js'

/** Off-peak reference instant: Tuesday 2026-11-03 13:00 Beijing. */
const OFFPEAK_NOW = Date.parse('2026-11-03T13:00:00+08:00')

/** Peak reference instant: Tuesday 2026-11-03 10:00 Beijing. */
const PEAK_NOW = Date.parse('2026-11-03T10:00:00+08:00')

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
 * Fake scheduler recording trigger passes, manual starts, and cancellations.
 *
 * @param {object} store - queue store bound to the fake engine.
 * @returns {object} engine stub.
 */
function fakeEngine(store) {
  const state = { ticks: 0, cancelled: [], started: [] }
  return {
    state,
    async tickNow() {
      state.ticks += 1
    },
    activeCount() {
      return state.started.filter((task) => task.status === 'running').length
    },
    cancelTask(id) {
      state.cancelled.push(id)
      return true
    },
    async startTask(id, trigger = 'manual', options = {}) {
      state.startOptions = options
      const started = store.startRun(id, trigger)
      if (started === null) return store.getTask(id)
      state.started.push(started)
      return store.getTask(id)
    },
  }
}

/**
 * Build a controller over a temp store with stub Host services.
 *
 * @param {{now?: number, services?: object}} [options] - fixture options.
 * @returns {object} fixture.
 */
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-controller-'))
  const dataFile = path.join(dir, 'queue.json')
  const logger = captureLogger()
  const clock = { now: options.now ?? OFFPEAK_NOW }
  const store = createStore({ dataFile, logger, now: () => clock.now })
  const engine = fakeEngine(store)
  const guidance = {
    registered: [],
    unregistered: [],
    register(agent, task) {
      this.registered.push({ agent, task })
      return true
    },
    unregister(taskId) {
      this.unregistered.push(taskId)
    },
  }
  const agent = { session: {} }
  const services = {
    modelCatalog: async () => ({
      default: { provider: 'deepseek-account', model: 'deepseek-flash', reasoningEffort: 'max' },
      groups: [{ id: 'deepseek-account', name: 'DeepSeek', models: [{ id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }] }],
      failures: [],
    }),
    workspaces: () => [{ id: 'ws-1', title: 'bookAnswer', path: '/Users/example/bookAnswer' }],
    defaultCwd: () => '/Users/example/bookAnswer',
    sessionTitleFor: (sessionId) => `会话 ${sessionId}`,
    sessionResolvable: () => true,
    isArchived: () => false,
    workspaceExists: () => true,
    agentFor: () => agent,
    ...(options.services ?? {}),
  }
  const controller = createController({ store, engine, guidance, logger, now: () => clock.now, services })
  return { controller, store, engine, guidance, logger, clock, agent, dataFile }
}

/**
 * Create a task through the pre-step creation path.
 *
 * @param {object} controller - controller fixture.
 * @param {string} [text] - task description.
 * @param {object} [extra] - creation fields.
 * @returns {object} task.
 */
function create(controller, text = '请整理书稿目录', extra = {}) {
  return controller.createTaskFromCreation({
    sessionId: 'session-source',
    workspaceId: 'ws-1',
    text,
    title: text.split('\n')[0],
    cwd: '/abs/work',
    ...extra,
  })
}

test('snapshot carries the v2 contract shape with armed sessions and stats', async () => {
  const { controller, store } = fixture()
  store.armSession('session-armed', 'ws-1')
  const snapshot = await controller.snapshot()
  assert.equal(snapshot.ok, true)
  assert.equal(snapshot.now, OFFPEAK_NOW)
  assert.equal(snapshot.period.kind, 'offpeak')
  assert.deepEqual(snapshot.counts, { queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, total: 0 })
  assert.deepEqual(snapshot.tasks, [])
  assert.deepEqual(snapshot.workspaces, [{ id: 'ws-1', title: 'bookAnswer', path: '/Users/example/bookAnswer' }])
  assert.deepEqual(snapshot.models, [{ provider: 'deepseek-account', model: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' }])
  assert.deepEqual(snapshot.defaultModel, { provider: 'deepseek-account', model: 'deepseek-flash' })
  assert.equal(snapshot.defaultCwd, '/Users/example/bookAnswer')
  assert.equal(snapshot.engine.active, 0)
  assert.equal(snapshot.engine.autoRun, true)
  assert.ok(path.isAbsolute(snapshot.engine.dataFile))
  assert.equal(snapshot.armed.length, 1)
  assert.equal(snapshot.armed[0].sessionId, 'session-armed')
  assert.deepEqual(snapshot.stats.lifetime, {
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
  })
  assert.deepEqual(snapshot.families, [
    { id: 'deepseek', label: 'DeepSeek', enabled: true },
    { id: 'glm', label: 'GLM', enabled: true },
  ])
  assert.equal(snapshot.periods.deepseek, snapshot.period)
  assert.equal(snapshot.periods.deepseek.kind, 'offpeak')
  assert.equal(snapshot.periods.glm.kind, 'offpeak')
  assert.deepEqual(snapshot.stats.byFamily, [])
  assert.equal(snapshot.stats.pricesVerifiedAt, '2026-10-10')
})

test('snapshot sorts running, queued by order, then finished; decorates tasks', async () => {
  const { controller, store, clock } = fixture()
  const doneTask = create(controller, '已完成的任务')
  store.startRun(doneTask.id, 'offpeak')
  clock.now += 10
  store.finishRun(doneTask.id, { status: 'done', turnEndKind: 'completed', resultSnippet: '完成' })
  const queuedA = create(controller, '排队 A')
  const queuedB = create(controller, '排队 B')
  const running = create(controller, '执行中')
  store.startRun(running.id, 'manual')
  const snapshot = await controller.snapshot()
  assert.deepEqual(snapshot.tasks.map((task) => task.status), ['running', 'queued', 'queued', 'done'])
  assert.deepEqual(snapshot.tasks.slice(1, 3).map((task) => task.id), [queuedA.id, queuedB.id])
  assert.equal(snapshot.tasks[0].nextRunAt, null)
  assert.ok(snapshot.tasks[1].nextRunAt !== null)
  assert.equal(snapshot.tasks[1].estimateOffPeak, true)
  assert.equal(snapshot.tasks[1].sourceSessionTitle, '会话 session-source')
})

test('queued nextRunAt points at the next off-peak start during peak', async () => {
  const { controller } = fixture({ now: PEAK_NOW })
  const task = create(controller, '高峰期排队的任务')
  const snapshot = await controller.snapshot()
  const decorated = snapshot.tasks.find((entry) => entry.id === task.id)
  assert.equal(snapshot.period.kind, 'peak')
  assert.equal(decorated.nextRunAt, snapshot.period.nextOffpeakAt)
  assert.equal(decorated.estimateOffPeak, false)
})

test('arm validates the workspace/session and caps armed sessions', async () => {
  const { controller } = fixture()
  const armed = await controller.arm('session-1', 'ws-1')
  assert.equal(armed.ok, true)
  assert.equal(armed.armed.sessionId, 'session-1')
  assert.equal(armed.armed.workspaceId, 'ws-1')

  const missingWorkspace = fixture({ services: { workspaceExists: () => false } })
  await assert.rejects(() => missingWorkspace.controller.arm('session-1', 'nope'), (error) => error instanceof ControllerError && error.status === 404)

  const archived = fixture({ services: { isArchived: () => true } })
  await assert.rejects(() => archived.controller.arm('session-1', 'ws-1'), (error) => error.status === 409)

  const unresolvable = fixture({ services: { sessionResolvable: () => false } })
  await assert.rejects(() => unresolvable.controller.arm('session-1', 'ws-1'), (error) => error.status === 404)

  const limited = fixture()
  for (let index = 0; index < 20; index += 1) await limited.controller.arm(`session-${index}`, 'ws-1')
  await assert.rejects(() => limited.controller.arm('session-over', 'ws-1'), (error) => error.status === 409)
  await assert.doesNotReject(() => limited.controller.arm('session-0', 'ws-1'), 're-arming an armed session is fine')
  await assert.rejects(() => limited.controller.arm('session-x'), /缺少 workspaceId/)
})

test('arm in update mode validates the queued task and stores the mode/taskId', async () => {
  const { controller, store } = fixture()
  const task = create(controller, '可修改的任务')
  const armed = await controller.arm('session-source', 'ws-1', { taskId: task.id })
  assert.equal(armed.armed.mode, 'update')
  assert.equal(armed.armed.taskId, task.id)

  await assert.rejects(() => controller.arm('session-source', 'ws-1', { taskId: 't-missing' }), (error) => error instanceof ControllerError && error.status === 404)
  store.cancelQueued(task.id)
  await assert.rejects(() => controller.arm('session-source', 'ws-1', { taskId: task.id }), (error) => error instanceof ControllerError && error.status === 409)
})

test('updateTaskFromCreation rewrites the queued task, disarms, and keeps its identity', () => {
  const { controller, store } = fixture()
  store.armSession('session-source', 'ws-1')
  const task = create(controller, '旧描述')
  store.armSession('session-source', 'ws-1', { mode: 'update', taskId: task.id })
  const updated = controller.updateTaskFromCreation({ sessionId: 'session-source', taskId: task.id, text: '新描述' })
  assert.equal(updated.id, task.id)
  assert.equal(updated.prompt, '新描述')
  assert.equal(updated.title, '新描述')
  assert.equal(store.counts().total, 1)
  assert.equal(store.getArmed('session-source'), null)
})

test('disarm is idempotent', () => {
  const { controller, store } = fixture()
  store.armSession('session-1', 'ws-1')
  assert.deepEqual(controller.disarm('session-1'), { ok: true, disarmed: true })
  assert.deepEqual(controller.disarm('session-1'), { ok: true, disarmed: true })
  assert.deepEqual(store.listArmed(), [])
})

test('createTaskFromCreation binds the task, disarms, counts the zero-call creation, and kicks later', async () => {
  const { controller, store, engine } = fixture()
  store.armSession('session-source', 'ws-1')
  const task = create(controller, '请整理书稿目录，输出 5 条要点。')
  assert.equal(task.status, 'queued')
  assert.equal(task.sourceSessionId, 'session-source')
  assert.equal(task.sessionId, 'session-source')
  assert.equal(task.sourceWorkspaceId, 'ws-1')
  assert.equal(task.cwd, '/abs/work')
  assert.equal(store.getArmed('session-source'), null)
  assert.equal(store.getLifetime().zeroCallCreations, 1)
  assert.equal(engine.state.ticks, 0, 'kick is deferred to the next macrotask')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(engine.state.ticks >= 1)
  assert.throws(() => controller.createTaskFromCreation({ sessionId: 'session-source', text: '   ' }), /不能为空/)
})

test('addTaskFromTool binds the calling session and needs one', async () => {
  const { controller, store, engine } = fixture()
  assert.throws(() => controller.addTaskFromTool(null, { prompt: '任务' }), /需要在会话中调用/)
  const result = controller.addTaskFromTool('session-caller', { prompt: '工具加入的任务' })
  assert.equal(result.ok, true)
  assert.equal(result.task.sourceSessionId, 'session-caller')
  assert.equal(result.task.title, '工具加入的任务')
  assert.equal(store.counts().queued, 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(engine.state.ticks >= 1)
})

test('updateTask edits queued tasks and refuses finished ones', () => {
  const { controller, store } = fixture()
  const task = create(controller, '原始指令')
  const updated = controller.updateTask(task.id, { title: '改后标题', prompt: '新指令' })
  assert.equal(updated.task.title, '改后标题')
  assert.equal(updated.task.prompt, '新指令')
  assert.equal(controller.updateTask(task.id, { title: '' }).task.title, '新指令', 'empty title falls back to the prompt')
  assert.throws(() => controller.updateTask('missing', { title: 'x' }), (error) => error.status === 404)
  store.startRun(task.id, 'offpeak')
  assert.throws(() => controller.updateTask(task.id, { title: '运行中' }), (error) => error.status === 409)
})

test('startTask starts a queued task manually and rejects other statuses', async () => {
  const { controller, store, engine } = fixture({ now: PEAK_NOW })
  const task = create(controller, '手动执行')
  const started = await controller.startTask(task.id)
  assert.equal(started.ok, true)
  assert.equal(started.task.status, 'running')
  assert.equal(started.task.runTrigger, 'manual')
  assert.equal(store.getTask(task.id).status, 'running')
  await assert.rejects(() => controller.startTask(task.id), (error) => error.status === 409)

  const queuedAgain = create(controller, '带选项的手动执行')
  const withOptions = await controller.startTask(queuedAgain.id, { waitForIdle: false })
  assert.equal(withOptions.task.status, 'running')
  assert.deepEqual(engine.state.startOptions, { waitForIdle: false }, 'run options are forwarded to the engine')
  await assert.rejects(() => controller.startTask('missing'), (error) => error.status === 404)
})

test('cancel handles queued and running tasks and disposes guidance', () => {
  const { controller, store, engine, guidance } = fixture()
  const queued = create(controller, '取消排队')
  const cancelled = controller.cancel(queued.id).task
  assert.equal(cancelled.status, 'cancelled')
  assert.ok(guidance.unregistered.includes(queued.id))

  const running = create(controller, '取消运行中')
  store.startRun(running.id, 'manual')
  const cancelledRunning = controller.cancel(running.id).task
  assert.equal(cancelledRunning.status, 'cancelled')
  assert.deepEqual(engine.state.cancelled, [running.id])
  assert.ok(guidance.unregistered.includes(running.id))
  assert.throws(() => controller.cancel(queued.id), (error) => error.status === 409)
})

test('retry requeues finished tasks and re-registers guidance on the live agent', () => {
  const { controller, store, guidance, agent } = fixture()
  const task = create(controller, '失败任务')
  store.startRun(task.id, 'offpeak')
  store.finishRun(task.id, { status: 'failed', turnEndKind: 'error', error: '模型调用失败' })
  const retried = controller.retry(task.id).task
  assert.equal(retried.status, 'queued')
  assert.equal(retried.error, null)
  assert.equal(guidance.registered.at(-1).agent, agent)
  assert.throws(() => controller.retry(task.id), (error) => error.status === 409)
})

test('remove deletes non-running tasks and refuses running ones', () => {
  const { controller, store, guidance } = fixture()
  const queued = create(controller, '删除排队')
  assert.deepEqual(controller.remove(queued.id), { ok: true, deleted: true })
  assert.ok(guidance.unregistered.includes(queued.id))
  assert.throws(() => controller.remove(queued.id), (error) => error.status === 404)

  const running = create(controller, '删除运行中')
  store.startRun(running.id, 'manual')
  assert.throws(() => controller.remove(running.id), (error) => error.status === 409)
})

test('move returns taskIds in queue order and validates direction/status', () => {
  const { controller, store } = fixture()
  const a = create(controller, 'A')
  const b = create(controller, 'B')
  assert.deepEqual(controller.move(b.id, 'up'), { ok: true, taskIds: [b.id, a.id] })
  assert.throws(() => controller.move(b.id, 'left'), /direction/)
  assert.throws(() => controller.move('missing', 'up'), (error) => error.status === 404)
  store.startRun(a.id, 'manual')
  assert.throws(() => controller.move(a.id, 'up'), (error) => error.status === 409)
})

test('updateSettings merges valid patches (including prices) and kicks the scheduler', async () => {
  const { controller, engine } = fixture()
  const before = engine.state.ticks
  const result = controller.updateSettings({ autoRun: false, maxConcurrent: 2, prices: { 'deepseek-flash': { cacheHit: 0.02, cacheMiss: 1, output: 4 } } })
  assert.equal(result.settings.autoRun, false)
  assert.equal(result.settings.maxConcurrent, 2)
  assert.deepEqual(result.settings.prices['deepseek-flash'], { cacheHit: 0.02, cacheMiss: 1, output: 4 })
  assert.ok(engine.state.ticks > before)
  assert.throws(() => controller.updateSettings({ bogus: 1 }), (error) => error.status === 400 && /未知的设置项/.test(error.message))
  assert.throws(() => controller.updateSettings({ prices: { x: { cacheHit: -1, cacheMiss: 1, output: 1 } } }), (error) => error.status === 400)
  assert.throws(() => controller.updateSettings('nope'), (error) => error.status === 400)
})

test('stats aggregates the ledger by range, day, and measured model', () => {
  const { controller, store } = fixture()
  const step = { at: OFFPEAK_NOW, tier: 'offpeak', usage: { inputTokens: 1000, outputTokens: 100 }, cost: 0.4, peakCost: 0.8, saved: 0.4, peakExtra: 0, provider: 'deepseek-account', model: 'deepseek-flash' }
  store.recordRun({
    taskId: 't-1', sessionId: 'session-source', title: 'A', model: 'deepseek-flash', provider: 'deepseek-account',
    trigger: 'offpeak', startedAt: OFFPEAK_NOW, finishedAt: OFFPEAK_NOW + 1000, status: 'done',
    steps: [step], usage: { inputTokens: 1000, outputTokens: 100 }, cost: 0.4, peakCost: 0.8, saved: 0.4, peakExtra: 0, unpriced: false,
  })
  store.recordRun({
    taskId: 't-2', sessionId: 'session-source', title: 'B', model: null, provider: null,
    trigger: 'manual', startedAt: OFFPEAK_NOW, finishedAt: OFFPEAK_NOW + 2000, status: 'failed',
    steps: [], usage: { inputTokens: 0, outputTokens: 0 }, cost: null, peakCost: null, saved: null, peakExtra: null, unpriced: false,
  })
  const stats = controller.stats('7')
  assert.equal(stats.ok, true)
  assert.equal(stats.days, 7)
  assert.equal(stats.lifetime.runs, 2)
  assert.equal(stats.range.runs, 2)
  assert.equal(stats.byDay.length, 1)
  assert.equal(stats.byDay[0].date, '2026-11-03')
  assert.equal(stats.byDay[0].runs, 2)
  assert.equal(stats.byModel.length, 1, 'zero-step runs are omitted from byModel')
  assert.equal(stats.byModel[0].model, 'deepseek-flash')
  assert.equal(stats.byModel[0].unpriced, false)
  assert.equal(stats.recentRuns.length, 2)
  assert.equal(stats.recentRuns[0].taskId, 't-2', 'newest run first')
  assert.equal(stats.recentRuns[0].stepCount, 0)
  assert.equal(stats.pricesVerifiedAt, '2026-10-10')
  assert.equal(controller.stats(0).days, 1, 'days is clamped to 1')
  assert.equal(controller.stats(999).days, 365, 'days is clamped to 365')
  assert.throws(() => controller.stats('abc'), (error) => error.status === 400)
})

test('listSummary returns decorated, bounded tasks for the agent tool', () => {
  const { controller } = fixture()
  for (let index = 0; index < 25; index += 1) create(controller, `任务 ${index}`)
  const summary = controller.listSummary(20)
  assert.equal(summary.tasks.length, 20)
  assert.equal(summary.counts.total, 25)
  assert.equal(summary.period.kind, 'offpeak')
  assert.equal(summary.tasks[0].sourceSessionId, 'session-source')
  assert.equal(controller.listSummary(3).tasks.length, 3)
})

// ────────────────────────────────────────────────────────────────────────────
// Model families: snapshot gating, per-family scheduling hints, stats split
// ────────────────────────────────────────────────────────────────────────────

test('a GLM task scheduled during DeepSeek peak uses the GLM calendar for nextRunAt', async () => {
  // Tuesday 10:00: DeepSeek peak until 12:00, GLM off-peak right now.
  const { controller, clock } = fixture({ now: PEAK_NOW })
  const glmTask = controller.createTaskFromCreation({ sessionId: 'session-glm', text: 'GLM 任务', modelFamily: 'glm' })
  const dsTask = controller.createTaskFromCreation({ sessionId: 'session-ds', text: 'DS 任务', modelFamily: 'deepseek' })
  const snapshot = await controller.snapshot()
  const glm = snapshot.tasks.find((task) => task.id === glmTask.id)
  const ds = snapshot.tasks.find((task) => task.id === dsTask.id)
  assert.equal(glm.modelFamily, 'glm')
  assert.equal(glm.modelFamilyLabel, 'GLM')
  assert.equal(glm.nextRunAt, snapshot.now, 'GLM is off-peak at 10:00 and runs immediately')
  assert.equal(ds.nextRunAt, Date.parse('2026-11-03T12:00:00+08:00'), 'DeepSeek waits for its own off-peak')
  assert.equal(snapshot.periods.glm.kind, 'offpeak')
  assert.equal(snapshot.periods.deepseek.kind, 'peak')
  clock.now = OFFPEAK_NOW
})

test('snapshot hides periods of disabled families but keeps decorating their tasks', async () => {
  const { controller, store } = fixture()
  store.setSettings({ familyEnabled: { glm: false } })
  const glmTask = controller.createTaskFromCreation({ sessionId: 'session-glm', text: 'GLM 任务', modelFamily: 'glm' })
  const snapshot = await controller.snapshot()
  assert.deepEqual(snapshot.families, [
    { id: 'deepseek', label: 'DeepSeek', enabled: true },
    { id: 'glm', label: 'GLM', enabled: false },
  ])
  assert.equal(snapshot.periods.glm, undefined, 'a disabled family shows no chip')
  assert.ok(snapshot.periods.deepseek, 'the enabled family still shows')
  const glm = snapshot.tasks.find((task) => task.id === glmTask.id)
  assert.equal(glm.nextRunAt, snapshot.now, '13:00 is off-peak for GLM too, so the hint stays honest')
})

test('addTaskFromTool classifies the calling model and rejects a disabled family', () => {
  const { controller, store } = fixture()
  const glm = controller.addTaskFromTool('session-glm', {
    prompt: 'GLM 任务',
    modelSelection: { provider: 'zai-coding-cn', model: 'glm-5.3' },
  })
  assert.equal(glm.task.modelFamily, 'glm')
  const fallback = controller.addTaskFromTool('session-any', { prompt: '普通任务' })
  assert.equal(fallback.task.modelFamily, 'deepseek', 'missing selections default to DeepSeek')

  store.setSettings({ familyEnabled: { glm: false } })
  assert.throws(
    () => controller.addTaskFromTool('session-glm2', { prompt: '再试', modelSelection: { provider: 'zai', model: 'glm-4.6' } }),
    (error) => error instanceof ControllerError && error.status === 409 && /GLM/.test(error.message),
  )
})

test('stats split by family with GLM credits, token totals, and per-model points', () => {
  const { controller, store } = fixture()
  store.recordRun({
    taskId: 't-ds', sessionId: 'session-source', title: 'DS', modelFamily: 'deepseek',
    model: 'deepseek-flash', provider: 'deepseek-account', trigger: 'offpeak',
    startedAt: OFFPEAK_NOW, finishedAt: OFFPEAK_NOW + 1000, status: 'done',
    steps: [{ at: OFFPEAK_NOW, tier: 'offpeak', usage: { inputTokens: 1000, outputTokens: 100 }, cost: 0.4, peakCost: 0.8, saved: 0.4, peakExtra: 0, provider: 'deepseek-account', model: 'deepseek-flash' }],
    usage: { inputTokens: 1000, outputTokens: 100 }, cost: 0.4, peakCost: 0.8, saved: 0.4, peakExtra: 0, unpriced: false,
  })
  store.recordRun({
    taskId: 't-glm', sessionId: 'session-source', title: 'GLM', modelFamily: 'glm',
    model: 'glm-5.3', provider: 'zai-coding-cn', trigger: 'offpeak',
    startedAt: OFFPEAK_NOW, finishedAt: OFFPEAK_NOW + 2000, status: 'done',
    steps: [{ at: OFFPEAK_NOW, tier: 'offpeak', usage: { inputTokens: 10000, outputTokens: 2000 }, points: 5.5, pointsSaved: 5.5, provider: 'zai-coding-cn', model: 'glm-5.3' }],
    usage: { inputTokens: 10000, outputTokens: 2000 }, cost: null, peakCost: null, saved: null, peakExtra: null, points: 5.5, pointsSaved: 5.5, unpriced: true,
  })
  const stats = controller.stats('7')
  assert.deepEqual(stats.byFamily.map((entry) => entry.family), ['deepseek', 'glm'])
  const glmFamily = stats.byFamily.find((entry) => entry.family === 'glm')
  assert.equal(glmFamily.runs, 1)
  assert.equal(glmFamily.points, 5.5)
  assert.equal(glmFamily.pointsSaved, 5.5)
  assert.equal(glmFamily.tokensIn, 10000)
  const glmModel = stats.byModel.find((entry) => entry.model === 'glm-5.3')
  assert.equal(glmModel.modelFamily, 'glm')
  assert.equal(glmModel.points, 5.5)
  assert.equal(glmModel.tokensIn + glmModel.tokensOut, 12000)
  assert.equal(stats.range.points, 5.5)
  assert.equal(stats.range.pointsSaved, 5.5)
  assert.equal(stats.recentRuns[0].modelFamily, 'glm', 'recent runs carry their family')

  const lifetime = store.getLifetime()
  assert.equal(lifetime.familyRuns.glm, 1)
  assert.equal(lifetime.familyRuns.deepseek, 1)
  assert.equal(lifetime.glmPoints, 5.5)
  assert.equal(lifetime.glmPointsSaved, 5.5)
})

test('updateSettings merges family switches over the live settings', async () => {
  const { controller, store } = fixture()
  const first = controller.updateSettings({ familyEnabled: { glm: false } })
  assert.deepEqual(first.settings.familyEnabled, { deepseek: true, glm: false })
  const second = controller.updateSettings({ familyEnabled: { deepseek: false } })
  assert.deepEqual(second.settings.familyEnabled, { deepseek: false, glm: false }, 'the earlier switch survives')
  const snapshot = await controller.snapshot()
  assert.equal(snapshot.periods.glm, undefined, 'a disabled family is hidden from the chips')
  assert.deepEqual(store.getSettings().familyEnabled, { deepseek: false, glm: false })
})
