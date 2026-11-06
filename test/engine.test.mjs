/**
 * Unit tests for the v2 queue scheduler (`host/engine.js`): off-peak gating,
 * manual starts, concurrency limits, queue order, settle persistence (task
 * outcome + run ledger), cancellation, and disposal.
 *
 * The session runner is a controllable fake; no sessions are created.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../host/store.js'
import { createEngine } from '../host/engine.js'

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
 * Fake session runner exposing each started run as a controllable handle.
 *
 * @returns {object} runner fake.
 */
function fakeRunner() {
  const calls = []
  const runner = {
    calls,
    startImpl: null,
    async start(task, settings, run) {
      const started = { task, settings, trigger: run.trigger, run, sessionId: task.sourceSessionId, cancelled: false }
      started.settled = new Promise((resolve) => {
        started.resolve = resolve
      })
      started.cancel = () => {
        started.cancelled = true
      }
      runner.calls.push(started)
      if (runner.startImpl !== null) return runner.startImpl(task, settings, started)
      return { sessionId: task.sourceSessionId, baseline: 10, settled: started.settled, cancel: started.cancel }
    },
  }
  return runner
}

/**
 * Build an engine over a temp store.
 *
 * @param {{now?: number, settings?: object}} [options] - fixture options.
 * @returns {object} fixture.
 */
function fixture(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-engine-'))
  const dataFile = path.join(dir, 'queue.json')
  const logger = captureLogger()
  const clock = { now: options.now ?? OFFPEAK_NOW }
  const store = createStore({ dataFile, logger, now: () => clock.now })
  if (options.settings !== undefined) store.setSettings(options.settings)
  const runner = fakeRunner()
  const intervals = new Map()
  const settledHooks = []
  let nextIntervalId = 1
  const engine = createEngine({
    store,
    runner,
    logger,
    now: () => clock.now,
    onRunSettled: (taskId) => settledHooks.push(taskId),
    setIntervalFn(callback) {
      const id = nextIntervalId++
      intervals.set(id, callback)
      return id
    },
    clearIntervalFn(id) {
      intervals.delete(id)
    },
  })
  return { engine, store, runner, logger, clock, intervals, settledHooks, dir, dataFile }
}

/**
 * Let engine microtasks and settle-triggered ticks run.
 *
 * @returns {Promise<void>} resolves after pending promises flushed.
 */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/**
 * Add one queued task through the store.
 *
 * @param {object} store - queue store.
 * @param {string} title - task title.
 * @param {{modelFamily?: string}} [options] - task options.
 * @returns {object} added task.
 */
function add(store, title, options = {}) {
  return store.createTask({
    title,
    prompt: title,
    modelFamily: options.modelFamily,
    sourceSessionId: 'session-source',
    sourceWorkspaceId: 'ws-1',
    cwd: '/abs/work',
  })
}

/**
 * Read one task through the store.
 *
 * @param {object} store - queue store.
 * @param {string} id - task id.
 * @returns {object} task.
 */
function taskOf(store, id) {
  const task = store.getTask(id)
  assert.ok(task !== null, `task ${id} exists`)
  return task
}

/**
 * Build one completed runner outcome.
 *
 * @param {object} [overrides] - outcome overrides.
 * @returns {object} outcome.
 */
function doneOutcome(overrides = {}) {
  return {
    kind: 'done',
    sessionId: 'session-source',
    turnEndKind: 'completed',
    error: null,
    resultSnippet: '收到',
    usage: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, reasoningTokens: 0 },
    cost: 0.5,
    peakCost: 1,
    saved: 0.5,
    peakExtra: 0,
    unpriced: false,
    provider: 'deepseek-account',
    model: 'deepseek-flash',
    steps: [{ at: OFFPEAK_NOW, tier: 'offpeak', usage: { inputTokens: 1000, outputTokens: 100 }, cost: 0.5, peakCost: 1, saved: 0.5, peakExtra: 0, provider: 'deepseek-account', model: 'deepseek-flash' }],
    ...overrides,
  }
}

test('off-peak starts queued tasks, records the ledger, and drains the next slot', async () => {
  const { engine, store, runner, settledHooks } = fixture({ settings: { maxConcurrent: 1 } })
  const first = add(store, '任务一')
  const second = add(store, '任务二')
  await engine.tickNow()
  assert.equal(taskOf(store, first.id).status, 'running')
  assert.equal(taskOf(store, first.id).runTrigger, 'offpeak')
  assert.equal(taskOf(store, second.id).status, 'queued')
  assert.equal(engine.activeCount(), 1)
  assert.equal(runner.calls.length, 1)
  assert.equal(runner.calls[0].trigger, 'offpeak')

  runner.calls[0].resolve(doneOutcome())
  await flush()
  const settled = taskOf(store, first.id)
  assert.equal(settled.status, 'done')
  assert.equal(settled.turnEndKind, 'completed')
  assert.equal(settled.sessionId, 'session-source')
  assert.equal(settled.resultSnippet, '收到')
  assert.equal(settled.cost, 0.5)
  assert.equal(settled.steps.length, 1)
  assert.equal(settled.baseline, 10, 'the runner baseline is persisted')

  const runs = store.listRuns()
  assert.equal(runs.length, 1, 'one run-ledger entry per run')
  assert.equal(runs[0].taskId, first.id)
  assert.equal(runs[0].sessionId, 'session-source')
  assert.equal(runs[0].trigger, 'offpeak')
  assert.equal(runs[0].status, 'done')
  assert.equal(runs[0].cost, 0.5)
  assert.equal(runs[0].model, 'deepseek-flash')
  assert.deepEqual(settledHooks, [first.id], 'guidance cleanup hook fires on settle')

  assert.equal(taskOf(store, second.id).status, 'running', 'next task starts after the settle')
  assert.equal(engine.activeCount(), 1)
})

/** Tuesday 2026-11-03 10:00 Beijing: DeepSeek peak (09–12) but GLM off-peak. */
const DEEPSEEK_PEAK_GLM_OFFPEAK = Date.parse('2026-11-03T10:00:00+08:00')

/** Tuesday 2026-11-03 15:00 Beijing: peak for both families. */
const BOTH_PEAK = Date.parse('2026-11-03T15:00:00+08:00')

test('tasks run on their own family calendar, not a single global period', async () => {
  // 10:00 Tuesday: DeepSeek is inside 09:00–12:00, GLM is not (14:00–18:00).
  const { engine, store, runner, clock } = fixture({ now: DEEPSEEK_PEAK_GLM_OFFPEAK })
  const glmTask = add(store, 'GLM 任务', { modelFamily: 'glm' })
  const dsTask = add(store, 'DeepSeek 任务', { modelFamily: 'deepseek' })
  await engine.tickNow()
  assert.equal(taskOf(store, glmTask.id).status, 'running', 'GLM is off-peak and starts')
  assert.equal(taskOf(store, dsTask.id).status, 'queued', 'DeepSeek is still inside its morning peak')

  clock.now = BOTH_PEAK
  const glmPeakTask = add(store, '另一个 GLM 任务', { modelFamily: 'glm' })
  await engine.tickNow()
  assert.equal(taskOf(store, glmPeakTask.id).status, 'queued', 'GLM peak blocks the new GLM task')
  runner.calls[0].resolve(doneOutcome())
  await flush()
  assert.equal(taskOf(store, dsTask.id).status, 'queued', '15:00 is still peak for DeepSeek too')
})

test('disabling a family stops interception but keeps scheduling its queued tasks', async () => {
  const { engine, store } = fixture({ now: DEEPSEEK_PEAK_GLM_OFFPEAK, settings: { familyEnabled: { glm: false } } })
  const glmTask = add(store, '已入队 GLM 任务', { modelFamily: 'glm' })
  await engine.tickNow()
  assert.equal(taskOf(store, glmTask.id).status, 'running', 'queued tasks keep their family calendar')
})

test('peak time blocks normal tasks but manual start works any time', async () => {
  const { engine, store, runner } = fixture({ now: PEAK_NOW })
  const normal = add(store, '普通任务')
  await engine.tickNow()
  assert.equal(taskOf(store, normal.id).status, 'queued', 'normal task waits for off-peak')

  const started = await engine.startTask(normal.id, 'manual', { waitForIdle: false })
  assert.equal(started.status, 'running')
  assert.equal(started.runTrigger, 'manual')
  assert.equal(engine.activeCount(), 1)
  assert.equal(runner.calls[0].run.waitForIdle, false, 'run options are forwarded to the runner')
})

test('autoRun:false stops automatic starts but manual start still works', async () => {
  const { engine, store } = fixture({ settings: { autoRun: false } })
  const normal = add(store, '自动任务')
  await engine.tickNow()
  assert.equal(taskOf(store, normal.id).status, 'queued')
  assert.equal(engine.activeCount(), 0)
  const started = await engine.startTask(normal.id, 'manual')
  assert.equal(started.status, 'running')
})

test('a task armed for editing is paused until the edit lands', async () => {
  const { engine, store, runner } = fixture()
  const task = add(store, '待修改任务')
  store.armSession('session-source', 'ws-1', { mode: 'update', taskId: task.id })
  await engine.tickNow()
  assert.equal(taskOf(store, task.id).status, 'queued', 'the scheduler skips the task being edited')
  assert.equal(runner.calls.length, 0)
  store.disarmSession('session-source')
  await engine.tickNow()
  assert.equal(taskOf(store, task.id).status, 'running')
})

test('maxConcurrent limits in-flight runs', async () => {
  const { engine, store, runner } = fixture({ settings: { maxConcurrent: 2 } })
  const tasks = [add(store, 'A'), add(store, 'B'), add(store, 'C')]
  await engine.tickNow()
  assert.equal(engine.activeCount(), 2)
  assert.deepEqual(tasks.map((task) => taskOf(store, task.id).status), ['running', 'running', 'queued'])
  assert.equal(runner.calls.length, 2)
})

test('queue order follows ascending order and forceRun jumps ahead', async () => {
  const { engine, store, runner } = fixture({ settings: { maxConcurrent: 1 } })
  const first = add(store, '第一个')
  const second = add(store, '第二个')
  store.markRunNow(second.id)
  await engine.tickNow()
  assert.equal(runner.calls[0].task.id, second.id, 'forceRun task jumps the queue')

  runner.calls[0].resolve(doneOutcome())
  await flush()
  assert.equal(runner.calls[1].task.id, first.id, 'then the queue proceeds in order')
})

test('runner start failure marks the task failed and records a zero-step run', async () => {
  const { engine, store, runner } = fixture()
  runner.startImpl = async () => {
    throw new Error('来源对话已归档，无法执行')
  }
  const task = add(store, '启动失败')
  await engine.tickNow()
  await flush()
  const failed = taskOf(store, task.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /来源对话已归档/)
  assert.equal(failed.turnEndKind, 'error')
  assert.equal(engine.activeCount(), 0)
  const runs = store.listRuns()
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'failed')
  assert.deepEqual(runs[0].steps, [])
  assert.equal(runs[0].model, null)
})

test('timeout and error outcomes become failed tasks with the readable reason', async () => {
  const { engine, store, runner } = fixture({ settings: { maxConcurrent: 2 } })
  const timeoutTask = add(store, '超时任务')
  const errorTask = add(store, '失败任务')
  await engine.tickNow()
  const callFor = (id) => runner.calls.find((call) => call.task.id === id)
  callFor(timeoutTask.id).resolve({ kind: 'timeout', turnEndKind: 'timeout', error: '超时（>120 分钟）' })
  callFor(errorTask.id).resolve({ kind: 'failed', turnEndKind: 'error', error: '模型调用失败' })
  await flush()
  assert.equal(taskOf(store, timeoutTask.id).status, 'failed')
  assert.match(taskOf(store, timeoutTask.id).error, /超时（>120 分钟）/)
  assert.equal(taskOf(store, errorTask.id).status, 'failed')
  assert.equal(taskOf(store, errorTask.id).error, '模型调用失败')
  assert.equal(store.listRuns().length, 2)
})

test('cancelled outcome lands as cancelled and keeps collected steps', async () => {
  const { engine, store, runner } = fixture()
  const task = add(store, '取消任务')
  await engine.tickNow()
  runner.calls[0].resolve(doneOutcome({ kind: 'cancelled', turnEndKind: 'aborted', error: null, cost: 0.1, saved: 0.1 }))
  await flush()
  const cancelled = taskOf(store, task.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.turnEndKind, 'aborted')
  assert.equal(cancelled.cost, 0.1)
  const run = store.listRuns()[0]
  assert.equal(run.status, 'cancelled')
  assert.equal(run.steps.length, 1)
})

test('cancelTask forwards to the in-flight handle and the late outcome is kept', async () => {
  const { engine, store, runner } = fixture()
  const task = add(store, '取消运行')
  await engine.tickNow()
  const call = runner.calls[0]
  assert.equal(engine.cancelTask(task.id), true)
  assert.equal(call.cancelled, true)
  assert.equal(engine.cancelTask('missing'), false)
  call.resolve(doneOutcome({ kind: 'cancelled', turnEndKind: 'aborted', error: null }))
  await flush()
  assert.equal(taskOf(store, task.id).status, 'cancelled')
})

test('start() ticks immediately and on the interval; dispose cancels runs and records them', async () => {
  const { engine, store, runner, intervals } = fixture()
  const task = add(store, '启动即跑')
  engine.start()
  await flush()
  assert.equal(intervals.size, 1, 'one interval registered')
  assert.equal(taskOf(store, task.id).status, 'running')
  assert.equal(engine.activeCount(), 1)

  for (const callback of [...intervals.values()]) callback()
  await flush()
  assert.equal(runner.calls.length, 1, 'interval tick does not double-start a running task')

  const running = runner.calls[0]
  await engine.dispose()
  assert.equal(intervals.size, 0, 'interval cleared on dispose')
  assert.equal(running.cancelled, true, 'in-flight turn is cancelled on dispose')
  const failed = taskOf(store, task.id)
  assert.equal(failed.status, 'failed')
  assert.match(failed.error, /插件卸载或 DSH 退出/)
  assert.equal(engine.activeCount(), 0)
  assert.equal(store.listRuns().length, 1, 'disposed runs still land in the ledger')
})

test('a disposed engine never launches again', async () => {
  const { engine, store, runner } = fixture()
  const task = add(store, '卸载后不跑')
  await engine.dispose()
  await engine.tickNow()
  assert.equal(taskOf(store, task.id).status, 'queued')
  assert.equal(runner.calls.length, 0)
})

test('serialized starts never double-claim one task', async () => {
  const { engine, store, runner } = fixture({ settings: { maxConcurrent: 5 } })
  for (let index = 0; index < 12; index += 1) add(store, `任务 ${index}`)
  await Promise.all([engine.tickNow(), engine.tickNow(), engine.tickNow()])
  const startedIds = runner.calls.map((call) => call.task.id)
  assert.equal(startedIds.length, 5)
  assert.equal(new Set(startedIds).size, 5, 'no duplicate start')
  assert.equal(store.counts().running, 5)
  assert.equal(store.counts().queued, 7)
})
