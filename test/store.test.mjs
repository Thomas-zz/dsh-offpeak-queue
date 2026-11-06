/**
 * Unit tests for the v2 queue store: task/arm/ledger mutations, persistence
 * round-trips, v1 migration, corrupt-file recovery, restart reconciliation,
 * arm pruning, and history/ledger caps.
 *
 * Every test writes into a fresh `mkdtemp` directory; the real
 * `~/.dsh/offpeak-queue.json` is never touched.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  ARM_MAX_AGE_MS,
  ARM_MAX_COUNT,
  DATA_VERSION,
  MAX_FINISHED_TASKS,
  MAX_RUNS,
  RESTART_ERROR,
  createStore,
  normalizeUsageTotals,
  resolveDataFile,
  titleFromPrompt,
} from '../host/store.js'
import { normalizeSettings } from '../host/policy.js'

/**
 * Create a temp directory for one test.
 *
 * @returns {string} absolute directory path.
 */
function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-store-'))
}

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
 * Build a store over a temp data file.
 *
 * @param {{now?: () => number, dataFile?: string}} [options] - store options.
 * @returns {{store: object, dir: string, dataFile: string, logger: object}} fixture.
 */
function fixture(options = {}) {
  const dir = tempDir()
  const dataFile = options.dataFile ?? path.join(dir, 'queue.json')
  const logger = captureLogger()
  const store = createStore({ dataFile, logger, now: options.now ?? (() => 1_000) })
  return { store, dir, dataFile, logger }
}

/**
 * Add one queued task bound to a source conversation.
 *
 * @param {object} store - store fixture.
 * @param {string} prompt - prompt text.
 * @param {object} [overrides] - field overrides.
 * @returns {object} added task.
 */
function add(store, prompt, overrides = {}) {
  return store.createTask({
    title: titleFromPrompt(prompt),
    prompt,
    sourceSessionId: 'session-source',
    sourceWorkspaceId: 'ws-1',
    cwd: '/abs/work',
    ...overrides,
  })
}

/**
 * Build one run-ledger record.
 *
 * @param {object} [overrides] - record overrides.
 * @returns {object} ledger record.
 */
function runRecord(overrides = {}) {
  return {
    taskId: 't-1',
    sessionId: 'session-source',
    title: '任务',
    model: 'deepseek-flash',
    provider: 'deepseek-account',
    trigger: 'offpeak',
    startedAt: 1_000,
    finishedAt: 2_000,
    status: 'done',
    steps: [],
    usage: { inputTokens: 10, outputTokens: 2 },
    cost: 0.5,
    peakCost: 1,
    saved: 0.5,
    peakExtra: 0,
    unpriced: false,
    ...overrides,
  }
}

test('resolveDataFile honors the explicit path and DSH_OFFPEAK_DATA_FILE', () => {
  assert.equal(resolveDataFile('/tmp/a/b.json'), '/tmp/a/b.json')
  const previous = process.env.DSH_OFFPEAK_DATA_FILE
  try {
    process.env.DSH_OFFPEAK_DATA_FILE = '/tmp/env-override/queue.json'
    assert.equal(resolveDataFile(undefined), '/tmp/env-override/queue.json')
  } finally {
    if (previous === undefined) delete process.env.DSH_OFFPEAK_DATA_FILE
    else process.env.DSH_OFFPEAK_DATA_FILE = previous
  }
  const previousHome = process.env.DSH_HOME
  try {
    delete process.env.DSH_OFFPEAK_DATA_FILE
    process.env.DSH_HOME = '/tmp/fake-dsh-home'
    assert.equal(resolveDataFile(undefined), '/tmp/fake-dsh-home/offpeak-queue.json')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('titleFromPrompt skips template-label lines and stays defensive', () => {
  assert.equal(titleFromPrompt('\n\n  整理书稿目录  \n第二行'), '整理书稿目录')
  assert.equal(titleFromPrompt('   '), '未命名任务')
  assert.equal(titleFromPrompt('a'.repeat(300)).length, 120)
  assert.equal(
    titleFromPrompt('请描述要在闲时执行的任务：\n任务目标：\n验收标准 / 输出要求：\n相关文件或目录：'),
    '未命名任务',
    'a template-only prompt has no meaningful title',
  )
  assert.equal(titleFromPrompt('请描述要在闲时执行的任务：\n任务目标：整理书稿目录'), '整理书稿目录')
  assert.equal(titleFromPrompt('验收标准 / 输出要求：输出 markdown 清单'), '输出 markdown 清单')
  assert.equal(normalizeUsageTotals(null), null)
  assert.deepEqual(normalizeUsageTotals({ inputTokens: 10, outputTokens: 2 }), { inputTokens: 10, outputTokens: 2, cacheReadTokens: 0, reasoningTokens: 0 })
})

test('createTask appends queued tasks bound to their source conversation', () => {
  const { store } = fixture()
  const first = add(store, '第一个任务')
  const second = add(store, '第二个任务\n更多指令')
  assert.equal(first.status, 'queued')
  assert.equal(first.order, 0)
  assert.equal(second.order, 1)
  assert.equal(first.title, '第一个任务')
  assert.equal(first.sourceSessionId, 'session-source')
  assert.equal(first.sessionId, 'session-source', 'task.sessionId tracks the source conversation')
  assert.equal(first.sourceWorkspaceId, 'ws-1')
  assert.equal(first.cwd, '/abs/work')
  assert.equal(first.turnEndKind, null)
  assert.deepEqual(first.steps, [])
  assert.equal(first.baseline, null)
  for (const field of ['id', 'order', 'title', 'prompt', 'status', 'sourceSessionId', 'sessionId', 'sourceWorkspaceId', 'cwd', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'attempts', 'forceRun', 'runTrigger', 'turnEndKind', 'error', 'resultSnippet', 'usage', 'cost', 'saved', 'peakExtra', 'steps', 'baseline']) {
    assert.ok(Object.hasOwn(first, field), `task has field ${field}`)
  }
  assert.deepEqual(store.counts(), { queued: 2, running: 0, done: 0, failed: 0, cancelled: 0, total: 2 })
  assert.deepEqual(store.listQueued().map((task) => task.id), [first.id, second.id])
})

test('flush writes an atomic document that a fresh store round-trips', () => {
  const { store, dir, dataFile } = fixture()
  add(store, '任务一')
  add(store, '任务二')
  store.armSession('session-armed', 'ws-1')
  store.recordRun(runRecord())
  store.incrementZeroCallCreations()
  const settings = store.setSettings({ autoRun: false, maxConcurrent: 2 })
  assert.equal(settings.autoRun, false)
  assert.equal(store.flush(), true)
  assert.equal(store.flush(), false, 'clean store flush is a no-op')
  const payload = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  assert.equal(payload.version, DATA_VERSION)
  assert.equal(payload.tasks.length, 2)
  assert.equal(Object.keys(payload.armed).length, 1)
  assert.equal(payload.runs.length, 1)
  assert.equal(payload.lifetime.runs, 1)
  assert.equal(payload.lifetime.zeroCallCreations, 1)
  assert.deepEqual(fs.readdirSync(dir).filter((name) => name.includes('.tmp-')), [])

  const reopened = createStore({ dataFile, logger: captureLogger(), now: () => 1_000 })
  assert.deepEqual(reopened.listTasks(), store.listTasks())
  assert.deepEqual(reopened.getSettings(), store.getSettings())
  assert.deepEqual(reopened.listArmed(), store.listArmed())
  assert.equal(reopened.getLifetime().runs, 1)
  assert.equal(reopened.listRuns().length, 1)
})

test('updateTask edits title/prompt and moveTask reorders queued tasks', () => {
  const { store } = fixture()
  const first = add(store, 'A')
  const second = add(store, 'B')
  const third = add(store, 'C')
  const updated = store.updateTask(first.id, { title: 'A 改', prompt: 'A 新指令' })
  assert.equal(updated.title, 'A 改')
  assert.equal(updated.prompt, 'A 新指令')

  assert.deepEqual(store.moveTask(third.id, 'up'), [first.id, third.id, second.id])
  assert.deepEqual(store.moveTask(third.id, 'up'), [third.id, first.id, second.id])
  assert.deepEqual(store.moveTask(third.id, 'up'), [third.id, first.id, second.id], 'top task cannot move further up')
  assert.deepEqual(store.listQueued().map((task) => [task.title, task.order]), [['C', 0], ['A 改', 1], ['B', 2]])
  assert.deepEqual(store.moveTask(third.id, 'down'), [first.id, third.id, second.id])
  assert.equal(store.moveTask('missing', 'up'), null)
})

test('cancel / retry / remove keep the source-conversation binding', () => {
  const { store } = fixture()
  const task = add(store, '可取消任务')
  const cancelled = store.cancelQueued(task.id)
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.finishedAt, 1_000)
  assert.equal(cancelled.sourceSessionId, 'session-source')
  assert.equal(cancelled.sessionId, 'session-source')

  const retried = store.retryTask(task.id)
  assert.equal(retried.status, 'queued')
  assert.equal(retried.order, 0, 'the only queued task takes order 0')
  assert.equal(retried.attempts, 0)
  assert.equal(retried.error, null)
  assert.equal(retried.sessionId, 'session-source')
  assert.deepEqual(retried.steps, [])

  const other = add(store, '删除我')
  assert.equal(store.removeTask(other.id), true)
  assert.equal(store.removeTask(other.id), false)
  assert.deepEqual(store.listTasks().map((entry) => entry.title), ['可取消任务'])
})

test('startRun / setRunBaseline / finishRun record a completed outcome', () => {
  const { store } = fixture()
  const task = add(store, '跑一次')
  const running = store.startRun(task.id, 'offpeak')
  assert.equal(running.status, 'running')
  assert.equal(running.attempts, 1)
  assert.equal(running.runTrigger, 'offpeak')
  assert.equal(running.startedAt, 1_000)
  assert.equal(running.sessionId, 'session-source')
  assert.equal(store.startRun(task.id, 'offpeak'), null, 'a running task cannot be claimed twice')

  store.setRunBaseline(task.id, 42)
  assert.equal(store.getTask(task.id).baseline, 42)

  const done = store.finishRun(task.id, {
    status: 'done',
    turnEndKind: 'completed',
    resultSnippet: '收到',
    usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 1, reasoningTokens: 0 },
    cost: 0.5,
    saved: 0.5,
    peakExtra: 0,
    steps: [{ at: 1_500, tier: 'offpeak', usage: { inputTokens: 10, outputTokens: 2 }, cost: 0.5, peakCost: 1, saved: 0.5, peakExtra: 0, provider: 'deepseek-account', model: 'deepseek-flash' }],
  })
  assert.equal(done.status, 'done')
  assert.equal(done.turnEndKind, 'completed')
  assert.equal(done.resultSnippet, '收到')
  assert.equal(done.sessionId, 'session-source')
  assert.equal(done.runTrigger, 'offpeak', 'runTrigger is kept after settling')
  assert.equal(done.cost, 0.5)
  assert.equal(done.saved, 0.5)
  assert.equal(done.steps.length, 1)
  assert.equal(done.finishedAt, 1_000)
})

test('finishRun lets a user-cancelled task accept its late same-status cost patch', () => {
  const { store } = fixture()
  const task = add(store, '取消后补步骤')
  store.startRun(task.id, 'manual')
  const cancelled = store.finishRun(task.id, { status: 'cancelled', turnEndKind: 'aborted' })
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cost, null)
  const patched = store.finishRun(task.id, {
    status: 'cancelled',
    turnEndKind: 'aborted',
    cost: 0.25,
    saved: 0.25,
    steps: [{ at: 1_500, tier: 'offpeak', usage: {}, cost: 0.25, peakCost: 0.5, saved: 0.25, peakExtra: 0, provider: 'deepseek-account', model: 'deepseek-flash' }],
  })
  assert.equal(patched.status, 'cancelled')
  assert.equal(patched.cost, 0.25)
  assert.equal(patched.steps.length, 1)

  const second = add(store, '完成后再收到晚到结果')
  store.startRun(second.id, 'manual')
  const done = store.finishRun(second.id, { status: 'done', turnEndKind: 'completed' })
  assert.equal(done.status, 'done')
  const late = store.finishRun(second.id, { status: 'cancelled', turnEndKind: 'aborted' })
  assert.equal(late.status, 'done', 'a later different-status settle never overrides a finished task')
})

test('recordRun appends to the ledger and folds lifetime aggregates', () => {
  const { store } = fixture()
  store.recordRun(runRecord({ cost: 0.4, peakCost: 0.8, saved: 0.4, peakExtra: 0, usage: { inputTokens: 100, outputTokens: 10 } }))
  store.recordRun(runRecord({ status: 'failed', unpriced: true, cost: null, saved: null, peakCost: null, peakExtra: null, usage: { inputTokens: 5, outputTokens: 1 } }))
  const lifetime = store.getLifetime()
  assert.equal(lifetime.runs, 2)
  assert.equal(lifetime.cost, 0.4)
  assert.equal(lifetime.saved, 0.4)
  assert.equal(lifetime.peakCost, 0.8)
  assert.equal(lifetime.peakExtra, 0)
  assert.equal(lifetime.tokensIn, 105)
  assert.equal(lifetime.tokensOut, 11)
  assert.equal(lifetime.unpricedRuns, 1)
  assert.equal(store.listRuns().length, 2)
  assert.equal(store.listRuns()[0].taskId, 't-1')
})

test('recordRun caps the ledger at MAX_RUNS while lifetime survives', () => {
  const { store } = fixture({ now: () => 1_000 })
  for (let index = 0; index < MAX_RUNS + 5; index += 1) {
    store.recordRun(runRecord({ title: `任务 ${index}`, cost: 0, saved: 0, peakCost: 0 }))
  }
  const runs = store.listRuns()
  assert.equal(runs.length, MAX_RUNS)
  assert.equal(runs[runs.length - 1].title, `任务 ${MAX_RUNS + 4}`, 'newest stays')
  assert.equal(store.getLifetime().runs, MAX_RUNS + 5, 'lifetime counts every run')
})

test('zeroCallCreations increments on pre-step task creation', () => {
  const { store } = fixture()
  assert.equal(store.getLifetime().zeroCallCreations, 0)
  store.incrementZeroCallCreations()
  store.incrementZeroCallCreations()
  assert.equal(store.getLifetime().zeroCallCreations, 2)
})

test('arms are stored, errored, listed oldest-first, and disarmed idempotently', () => {
  const clock = { now: 1_000 }
  const { store } = fixture({ now: () => clock.now })
  store.armSession('session-a', 'ws-1')
  clock.now += 10
  store.armSession('session-b', 'ws-2')
  assert.deepEqual(store.listArmed().map((arm) => arm.sessionId), ['session-a', 'session-b'])
  assert.deepEqual(store.getArmed('session-a').workspaceId, 'ws-1')
  assert.equal(store.getArmed('missing'), null)

  store.setArmError('session-a', '任务描述不能为空')
  assert.equal(store.getArmed('session-a').lastError, '任务描述不能为空')
  assert.equal(store.armSession('session-a', 'ws-1').lastError, null, 're-arming clears the prior error')

  assert.equal(store.disarmSession('session-a'), true)
  assert.equal(store.disarmSession('session-a'), false)
  assert.deepEqual(store.listArmed().map((arm) => arm.sessionId), ['session-b'])
})

test('pruneArms drops stale and excess arms', () => {
  const clock = { now: 1_000_000 }
  const { store } = fixture({ now: () => clock.now })
  store.armSession('fresh', 'ws-1')
  clock.now -= ARM_MAX_AGE_MS
  store.armSession('stale', 'ws-1')
  clock.now += ARM_MAX_AGE_MS + 1
  assert.equal(store.pruneArms(), 1, 'one stale arm removed')
  assert.equal(store.getArmed('stale'), null)
  assert.equal(store.getArmed('fresh') !== null, true)

  for (let index = 0; index < ARM_MAX_COUNT + 3; index += 1) {
    clock.now += 1
    store.armSession(`session-${index}`, 'ws-1')
  }
  const removed = store.pruneArms()
  assert.ok(removed >= 3, 'oldest arms beyond the cap are removed')
  assert.equal(store.listArmed().length, ARM_MAX_COUNT)
  assert.equal(store.getArmed(`session-${ARM_MAX_COUNT + 2}`) !== null, true, 'newest arm is kept')
})

test('corrupt file is moved aside and the store starts clean with a warning', () => {
  const dir = tempDir()
  const dataFile = path.join(dir, 'queue.json')
  fs.writeFileSync(dataFile, '{not json', 'utf8')
  const logger = captureLogger()
  const store = createStore({ dataFile, logger })
  assert.deepEqual(store.listTasks(), [])
  const backups = fs.readdirSync(dir).filter((name) => name.startsWith('queue.json.corrupt-'))
  assert.equal(backups.length, 1)
  assert.ok(logger.warnings.some((line) => line.includes('已损坏')))
})

test('v1 documents migrate by dropping sourceless tasks and keeping settings', () => {
  const dir = tempDir()
  const dataFile = path.join(dir, 'queue.json')
  const logger = captureLogger()
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 1,
    settings: { autoRun: false, timeZone: 'Asia/Shanghai', maxConcurrent: 3 },
    tasks: [
      { id: 't-1', title: 'v1 表单任务', prompt: 'x', status: 'queued', order: 0 },
      { id: 't-2', title: 'v1 已完成', prompt: 'y', status: 'done', order: 0 },
    ],
  }), 'utf8')
  const store = createStore({ dataFile, logger })
  assert.equal(store.migratedFrom, 1)
  assert.deepEqual(store.listTasks(), [], 'v1 tasks without sourceSessionId are dropped')
  assert.equal(store.getSettings().autoRun, false)
  assert.equal(store.getSettings().maxConcurrent, 3)
  assert.deepEqual(store.listRuns(), [])
  assert.equal(store.getLifetime().runs, 0)
  assert.ok(logger.warnings.some((line) => line.includes('数据从 v1 迁移到 v5')))
  store.flush()
  const payload = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  assert.equal(payload.version, DATA_VERSION)
  assert.deepEqual(payload.tasks, [])
})

test('v3 documents migrate to v4 and force automatic execution', () => {
  const dir = tempDir()
  const dataFile = path.join(dir, 'queue.json')
  const logger = captureLogger()
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 3,
    settings: { autoRun: false, maxConcurrent: 5, timeZone: 'Asia/Shanghai' },
    tasks: [],
  }), 'utf8')
  const store = createStore({ dataFile, logger })
  assert.equal(store.migratedFrom, 3)
  assert.equal(store.getSettings().autoRun, true)
  assert.equal(store.getSettings().maxConcurrent, 5, 'an explicit concurrency survives')
  assert.ok(logger.warnings.some((line) => line.includes('始终自动执行')))
  store.flush()
  const payload = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  assert.equal(payload.version, DATA_VERSION)
  assert.equal(payload.settings.autoRun, true)
})

test('v2 documents migrate to v4, lift the concurrency default, and force auto-run', () => {
  const dir = tempDir()
  const dataFile = path.join(dir, 'queue.json')
  const logger = captureLogger()
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 2,
    settings: { autoRun: true, maxConcurrent: 1, timeZone: 'Asia/Shanghai' },
    tasks: [],
  }), 'utf8')
  const store = createStore({ dataFile, logger })
  assert.equal(store.migratedFrom, 2)
  assert.equal(store.getSettings().maxConcurrent, 3, 'the old default becomes the new default')
  assert.ok(logger.warnings.some((line) => line.includes('最大并发默认值改为 3')))
  assert.equal(store.getSettings().autoRun, true, 'auto-run is mandatory now')
  store.flush()
  const payload = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  assert.equal(payload.version, DATA_VERSION)
  assert.equal(payload.settings.maxConcurrent, 3)
})

test('v2 documents keep an explicit non-default concurrency', () => {
  const dir = tempDir()
  const dataFile = path.join(dir, 'queue.json')
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 2,
    settings: { autoRun: true, maxConcurrent: 2, timeZone: 'Asia/Shanghai' },
    tasks: [],
  }), 'utf8')
  const store = createStore({ dataFile, logger: captureLogger() })
  assert.equal(store.getSettings().maxConcurrent, 2)
})

test('v2 tasks without a source conversation are dropped on load', () => {
  const dir = tempDir()
  const dataFile = path.join(dir, 'queue.json')
  const logger = captureLogger()
  fs.writeFileSync(dataFile, JSON.stringify({
    version: DATA_VERSION,
    settings: {},
    tasks: [{ id: 't-bad', title: '无来源', prompt: 'x', status: 'queued', order: 0 }],
    armed: {},
    runs: [],
    lifetime: {},
  }), 'utf8')
  const store = createStore({ dataFile, logger })
  assert.deepEqual(store.listTasks(), [])
})

test('running tasks are reconciled to failed after a restart', () => {
  const dir = tempDir()
  const dataFile = path.join(dir, 'queue.json')
  const logger = captureLogger()
  const first = createStore({ dataFile, logger })
  const task = add(first, '中断的任务')
  first.startRun(task.id, 'offpeak')
  first.flush()

  const second = createStore({ dataFile, logger })
  const recovered = second.getTask(task.id)
  assert.equal(recovered.status, 'failed')
  assert.equal(recovered.error, RESTART_ERROR)
  assert.equal(recovered.turnEndKind, 'interrupted')
  assert.equal(recovered.sessionId, 'session-source')
  assert.ok(recovered.finishedAt !== null)
  assert.ok(logger.warnings.some((line) => line.includes('已标记为失败')))
})

test('finished history is capped while queued and running tasks are kept', () => {
  let clock = 1_000
  const { store } = fixture({ now: () => clock })
  const finishedIds = []
  for (let index = 0; index < MAX_FINISHED_TASKS + 5; index += 1) {
    const task = add(store, `任务 ${index}`)
    store.startRun(task.id, 'offpeak')
    clock += 100
    store.finishRun(task.id, { status: 'done', turnEndKind: 'completed' })
    finishedIds.push(task.id)
    clock += 100
  }
  const pending = add(store, '还在队列里')
  const counts = store.counts()
  assert.equal(counts.done, MAX_FINISHED_TASKS)
  assert.equal(counts.queued, 1)
  const remaining = new Set(store.listTasks().map((task) => task.id))
  assert.ok(remaining.has(pending.id))
  assert.ok(!remaining.has(finishedIds[0]))
  assert.ok(remaining.has(finishedIds[finishedIds.length - 1]))
})

test('task content blocks survive a persistence round-trip and are sanitized on load', () => {
  const { store, dataFile } = fixture()
  const image = { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 10, height: 20, bytes: 30, name: 'image.png', extra: 'dropped' } }
  const task = add(store, '看看这个 UI', {
    content: [image, { type: 'text', text: '看看这个 UI' }, { type: 'reasoning', text: 'x' }, { type: 'image', attachment: {} }],
  })
  assert.deepEqual(task.content, [
    { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 10, height: 20, bytes: 30, name: 'image.png' } },
    { type: 'text', text: '看看这个 UI' },
  ])
  store.flush()

  const reopened = createStore({ dataFile, logger: captureLogger(), now: () => 1_000 })
  const loaded = reopened.listTasks().find((entry) => entry.id === task.id)
  assert.equal(loaded.content.length, 2)
  assert.equal(loaded.content[0].attachment.attachmentId, 'sha256:abc')
  assert.equal(loaded.content[1].text, '看看这个 UI')

  const edited = reopened.updateTask(task.id, { content: [{ type: 'text', text: '改过的任务' }] })
  assert.deepEqual(edited.content, [{ type: 'text', text: '改过的任务' }])
})

// ────────────────────────────────────────────────────────────────────────────
// Data format v5: model families, per-family switches, GLM credit counters
// ────────────────────────────────────────────────────────────────────────────

test('v4 documents migrate to v5 with family defaults and rewritten version', () => {
  const dir = tempDir()
  const dataFile = path.join(dir, 'queue.json')
  const logger = captureLogger()
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 4,
    settings: { maxConcurrent: 4 },
    tasks: [{ id: 't-legacy', sourceSessionId: 'session-old', status: 'queued', title: '旧任务', prompt: '旧任务' }],
    armed: {},
    runs: [],
    lifetime: { runs: 3, saved: 0.5 },
  }), 'utf8')
  const store = createStore({ dataFile, logger })
  assert.equal(store.migratedFrom, 4)
  assert.deepEqual(store.getSettings().familyEnabled, { deepseek: true, glm: true })
  assert.equal(store.getTask('t-legacy').modelFamily, 'deepseek')
  assert.deepEqual(store.getLifetime().familyRuns, { deepseek: 0, glm: 0 }, 'family counters start fresh at migration')
  assert.ok(logger.warnings.some((line) => line.includes('数据从 v4 迁移到 v5')))
  store.flush()
  const payload = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  assert.equal(payload.version, DATA_VERSION)
  assert.equal(payload.tasks[0].modelFamily, 'deepseek')
})

test('modelFamily is validated on load and persisted on create', () => {
  const { store, dataFile, dir } = fixture()
  const glm = store.createTask({ title: 'GLM', prompt: 'GLM', sourceSessionId: 's-1', modelFamily: 'glm' })
  const bogus = store.createTask({ title: 'x', prompt: 'x', sourceSessionId: 's-2', modelFamily: 'qwen' })
  assert.equal(glm.modelFamily, 'glm')
  assert.equal(bogus.modelFamily, 'deepseek', 'unknown families coerce to DeepSeek')
  store.flush()
  const raw = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  raw.tasks[0].modelFamily = 'weird'
  fs.writeFileSync(dataFile, JSON.stringify(raw), 'utf8')
  const reloaded = createStore({ dataFile: path.join(dir, 'queue2.json') })
  void reloaded
  const reloadedSame = createStore({ dataFile })
  assert.equal(reloadedSame.getTask(raw.tasks[0].id).modelFamily, 'deepseek', 'tampered families are sanitized on load')
})

test('familyEnabled settings validate strictly and merge partially', () => {
  const { store } = fixture()
  // The HTTP path merges patches over the current settings before storing,
  // mirroring `controller.updateSettings`.
  const step1 = normalizeSettings({ familyEnabled: { glm: false } }, store.getSettings())
  store.setSettings(step1)
  assert.deepEqual(store.getSettings().familyEnabled, { deepseek: true, glm: false })
  const step2 = normalizeSettings({ familyEnabled: { deepseek: false } }, store.getSettings())
  store.setSettings(step2)
  assert.deepEqual(store.getSettings().familyEnabled, { deepseek: false, glm: false })
  assert.throws(() => normalizeSettings({ familyEnabled: { qwen: true } }, store.getSettings()), /未知的模型开关：qwen/)
  assert.throws(() => normalizeSettings({ familyEnabled: { glm: 'on' } }, store.getSettings()), /模型开关 glm 必须是布尔值/)
  assert.throws(() => normalizeSettings({ familyEnabled: [true] }, store.getSettings()), /familyEnabled 必须是对象/)
})

test('recordRun folds per-family counters and GLM credits into the lifetime block', () => {
  const { store } = fixture()
  store.recordRun({
    taskId: 't-glm', sessionId: 's', title: 'GLM', modelFamily: 'glm',
    model: 'glm-5.3', provider: 'zai', trigger: 'offpeak', startedAt: 1, finishedAt: 2, status: 'done',
    steps: [{ at: 1, tier: 'offpeak', usage: { inputTokens: 1, outputTokens: 1 }, points: 5, pointsSaved: 5, provider: 'zai', model: 'glm-5.3' }],
    usage: { inputTokens: 1, outputTokens: 1 }, points: 5, pointsSaved: 5, unpriced: true,
  })
  store.recordRun({
    taskId: 't-ds', sessionId: 's', title: 'DS', trigger: 'offpeak', startedAt: 1, finishedAt: 2, status: 'done',
    steps: [], usage: { inputTokens: 0, outputTokens: 0 }, unpriced: false,
  })
  const lifetime = store.getLifetime()
  assert.equal(lifetime.familyRuns.glm, 1)
  assert.equal(lifetime.familyRuns.deepseek, 1, 'runs without provider/model default to the DeepSeek family')
  assert.equal(lifetime.glmPoints, 5)
  assert.equal(lifetime.glmPointsSaved, 5)
})
