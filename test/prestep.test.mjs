/**
 * Unit tests for the zero-call creation interceptor (`host/prestep.js`).
 *
 * Covers message extraction/validation, the content blocks carried on the task
 * (the plugin never writes the creation message into the session log, because
 * only the Agent loop may open a log's surface with its protected system head),
 * the reject path, the fallback `next()` path, and idempotency after disarm.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../host/store.js'
import { createController } from '../host/controller.js'
import {
  EMPTY_DESCRIPTION_ERROR,
  createPrestep,
  extractTaskContent,
  extractTaskText,
  validateTaskText,
} from '../host/prestep.js'

/** Off-peak reference instant: Tuesday 2026-11-03 13:00 Beijing. */
const NOW = Date.parse('2026-11-03T13:00:00+08:00')

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
 * Build a pre-step fixture over a temp store and the real controller.
 *
 * @returns {object} fixture.
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-prestep-'))
  const logger = captureLogger()
  const store = createStore({ dataFile: path.join(dir, 'queue.json'), logger, now: () => NOW })
  const engine = {
    ticks: 0,
    async tickNow() {
      this.ticks += 1
    },
    activeCount() {
      return 0
    },
    cancelTask() {
      return false
    },
    async startTask() {
      return null
    },
  }
  const guidance = {
    registered: [],
    register(agent, task) {
      this.registered.push({ agent, task })
      return true
    },
    unregister() {},
  }
  const controller = createController({
    store,
    engine,
    guidance,
    logger,
    now: () => NOW,
    services: {
      modelCatalog: async () => ({ default: null, groups: [], failures: [] }),
      workspaces: () => [],
      defaultCwd: () => '/abs/default',
      sessionTitleFor: () => undefined,
    },
  })
  const titleCalls = []
  const ctx = {
    get(name) {
      if (name === 'sessionTitle') {
        return {
          rename(session, title) {
            titleCalls.push([session.id, title])
            return { title }
          },
        }
      }
      return undefined
    },
    on() {
      return () => {}
    },
  }
  const prestep = createPrestep({ ctx, store, guidance, controller, logger })
  return { prestep, controller, store, engine, guidance, titleCalls, logger, dir }
}

/**
 * Build a fake agent/session recording durable appends.
 *
 * @param {string} [sessionId] - session id.
 * @returns {{agent: object, session: object, appended: object[]}} fake agent.
 */
function fakeAgent(sessionId = 'session-1') {
  const appended = []
  const session = {
    id: sessionId,
    header: { cwd: '/abs/work' },
    append(type, data, options) {
      appended.push({ type, data, options })
    },
  }
  return { agent: { session }, appended }
}

/**
 * Build one claimed user message.
 *
 * @param {string} text - message text.
 * @returns {object} user message.
 */
function claimedMessage(text) {
  return { id: 'm-1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId: 'rpc-1', clientTimeZone: 'Asia/Shanghai' } }
}

/**
 * Arm one session in the fixture store.
 *
 * @param {object} store - queue store.
 * @param {string} sessionId - session id.
 * @returns {void}
 */
function arm(store, sessionId) {
  store.armSession(sessionId, 'ws-1')
}

test('extractTaskText joins text blocks and ignores non-text content', () => {
  assert.equal(extractTaskText([]), '')
  assert.equal(extractTaskText(undefined), '')
  assert.equal(
    extractTaskText([
      { content: [{ type: 'text', text: '第一行' }, { type: 'image', attachment: { id: 'a' } }] },
      { content: [{ type: 'text', text: '第二行' }] },
      { content: [{ type: 'text', text: '   ' }] },
    ]),
    '第一行\n\n第二行',
  )
})

test('validateTaskText rejects empty and template-only descriptions', () => {
  assert.equal(validateTaskText(''), EMPTY_DESCRIPTION_ERROR)
  assert.equal(validateTaskText('   \n  '), EMPTY_DESCRIPTION_ERROR)
  assert.equal(validateTaskText('请描述要在闲时执行的任务：\n任务目标：\n验收标准 / 输出要求：\n相关文件或目录：'), EMPTY_DESCRIPTION_ERROR)
  assert.equal(validateTaskText('请描述要在闲时执行的任务：\n任务目标：整理目录'), null)
  assert.equal(validateTaskText('整理书稿目录，输出 markdown 清单。'), null)
})

test('extractTaskContent keeps text and attachment blocks in submission order', () => {
  const attachment = { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 10, height: 20, bytes: 30, name: 'image.png' }
  const messages = [
    {
      content: [
        { type: 'image', attachment },
        { type: 'text', text: '   ' },
        { type: 'text', text: '看看这两个截图' },
      ],
    },
    { content: [{ type: 'file', attachment: { attachmentId: 'sha256:def' } }] },
  ]
  assert.deepEqual(extractTaskContent(messages), [
    { type: 'image', attachment },
    { type: 'text', text: '看看这两个截图' },
    { type: 'file', attachment: { attachmentId: 'sha256:def' } },
  ])
  assert.deepEqual(extractTaskContent(undefined), [])
  assert.deepEqual(extractTaskContent([{ content: [{ type: 'reasoning', text: 'x' }] }]), [])
})

test('creation stores the content blocks on the task and writes nothing to the session log', async () => {
  const { prestep, store } = fixture()
  const { agent, appended } = fakeAgent('session-content')
  arm(store, 'session-content')
  const image = { type: 'image', attachment: { attachmentId: 'sha256:abc', mediaType: 'image/png', width: 10, height: 20, bytes: 30, name: 'image.png' } }
  const decision = await prestep.handle(
    { agent, messages: [{ id: 'm-2', role: 'user', content: [image, { type: 'text', text: '看看这个 UI' }] }] },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(decision, { kind: 'reject' })
  assert.deepEqual(appended, [], 'a rejected step must never write a surface event')
  const task = store.listTasks()[0]
  assert.deepEqual(task.content, [image, { type: 'text', text: '看看这个 UI' }])
})

test('an unarmed session falls through to next() without appending', async () => {
  const { prestep } = fixture()
  const { agent, appended } = fakeAgent()
  let nextCalls = 0
  const decision = await prestep.handle({ agent, messages: [claimedMessage('普通消息')] }, () => {
    nextCalls += 1
    return Promise.resolve({ kind: 'enter', messages: [] })
  })
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(nextCalls, 1)
  assert.deepEqual(appended, [])
})

test('an invalid (template-only) description keeps the session armed and rejects the step', async () => {
  const { prestep, store } = fixture()
  const { agent, appended } = fakeAgent('session-invalid')
  arm(store, 'session-invalid')
  let nextCalls = 0
  const decision = await prestep.handle(
    { agent, messages: [claimedMessage('请描述要在闲时执行的任务：\n任务目标：')] },
    () => { nextCalls += 1; return Promise.resolve({ kind: 'enter', messages: [] }) },
  )
  assert.deepEqual(decision, { kind: 'reject' })
  assert.equal(nextCalls, 0)
  assert.deepEqual(appended, [], 'the rejected step writes no surface event')
  assert.equal(store.counts().total, 0, 'no task is created')
  assert.equal(store.getArmed('session-invalid').lastError, EMPTY_DESCRIPTION_ERROR)
})

test('a valid description creates the task, disarms, renames, and rejects without touching the log', async () => {
  const { prestep, store, guidance, titleCalls, engine } = fixture()
  const { agent, appended } = fakeAgent('session-valid')
  arm(store, 'session-valid')
  const decision = await prestep.handle(
    { agent, messages: [claimedMessage('整理书稿目录，输出 5 条要点。')] },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(decision, { kind: 'reject' }, 'zero model call: the step is rejected')
  assert.deepEqual(appended, [], 'the plugin must not open the session surface')
  assert.equal(store.getArmed('session-valid'), null, 'session disarmed after creation')
  assert.equal(store.counts().total, 1)
  const task = store.listTasks()[0]
  assert.deepEqual(task.content, [{ type: 'text', text: '整理书稿目录，输出 5 条要点。' }])
  assert.equal(task.status, 'queued')
  assert.equal(task.sourceSessionId, 'session-valid')
  assert.equal(task.sessionId, 'session-valid')
  assert.equal(task.sourceWorkspaceId, 'ws-1')
  assert.equal(task.cwd, '/abs/work')
  assert.equal(task.title, '整理书稿目录，输出 5 条要点')
  assert.equal(store.getLifetime().zeroCallCreations, 1)
  assert.deepEqual(titleCalls, [['session-valid', '闲时任务 · 整理书稿目录，输出 5 条要点']], 'trailing punctuation is trimmed for the title')
  assert.equal(guidance.registered.length, 1)
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(engine.ticks >= 1, true, 'creation kicks the scheduler on the next macrotask')
})

test('an update-mode arm rewrites the queued task from the submitted message', async () => {
  const { prestep, store, guidance } = fixture()
  const { agent, appended } = fakeAgent('session-edit')
  arm(store, 'session-edit')
  await prestep.handle({ agent, messages: [claimedMessage('旧任务描述')] }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  const task = store.listTasks()[0]
  appended.length = 0
  store.armSession('session-edit', 'ws-1', { mode: 'update', taskId: task.id })
  const decision = await prestep.handle(
    { agent, messages: [claimedMessage('新任务描述：整理会议纪要并附上截图')] },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  assert.deepEqual(decision, { kind: 'reject' }, 'editing is also zero-call')
  assert.deepEqual(appended, [], 'editing writes nothing to the session log')
  const updated = store.getTask(task.id)
  assert.equal(updated.id, task.id, 'the task keeps its identity and queue position')
  assert.equal(updated.prompt, '新任务描述：整理会议纪要并附上截图')
  assert.equal(updated.title, '新任务描述：整理会议纪要并附上截图')
  assert.equal(store.counts().total, 1, 'no second task is created')
  assert.equal(store.getArmed('session-edit'), null, 'the edit arm disarms')
  assert.equal(guidance.registered.length, 2, 'guidance is refreshed with the new title')
  assert.equal(guidance.registered.at(-1).task.title, updated.title)
})

test('the renamed conversation title is truncated to keep the sidebar readable', async () => {
  const { prestep, store, titleCalls } = fixture()
  const { agent } = fakeAgent('session-long')
  arm(store, 'session-long')
  const longText = '请整理一份非常长的书稿目录' + '并补全所有章节的摘要与验收标准'.repeat(6)
  await prestep.handle({ agent, messages: [claimedMessage(longText)] }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  assert.equal(titleCalls.length, 1)
  const renamed = titleCalls[0][1]
  assert.ok(renamed.startsWith('闲时任务 · '))
  const shortPart = renamed.slice('闲时任务 · '.length)
  assert.ok(shortPart.length <= 40, `rename title part is ≤40 chars (got ${shortPart.length})`)
  assert.ok(shortPart.endsWith('…'))
  const task = store.listTasks()[0]
  assert.ok(task.title.length > 40, 'the persisted task title keeps up to 120 chars')
})

test('creation failures fall back to next() without appending (no duplicate message)', async () => {
  const { store } = fixture()
  const logger = captureLogger()
  const guidance = { registered: [], register() { return true }, unregister() {} }
  const failingController = {
    createTaskFromCreation() {
      throw new Error('boom')
    },
  }
  const ctx = { get: () => undefined, on: () => () => {} }
  const prestep = createPrestep({ ctx, store, guidance, controller: failingController, logger })
  const { agent, appended } = fakeAgent('session-fail')
  arm(store, 'session-fail')
  let nextCalls = 0
  const decision = await prestep.handle(
    { agent, messages: [claimedMessage('请整理书稿目录')] },
    () => { nextCalls += 1; return Promise.resolve({ kind: 'enter', messages: [] }) },
  )
  assert.deepEqual(decision, { kind: 'enter', messages: [] }, 'the loop runs the normal turn')
  assert.equal(nextCalls, 1)
  assert.deepEqual(appended, [], 'the listener must not append when falling back')
  assert.equal(store.getArmed('session-fail').lastError.startsWith('创建闲时任务失败'), true)
  assert.equal(store.counts().total, 0)
})

test('a null creation result also falls back to next() without appending', async () => {
  const { store } = fixture()
  const guidance = { registered: [], register() { return true }, unregister() {} }
  const nullController = { createTaskFromCreation: () => null }
  const ctx = { get: () => undefined, on: () => () => {} }
  const prestep = createPrestep({ ctx, store, guidance, controller: nullController, logger: captureLogger() })
  const { agent, appended } = fakeAgent('session-null')
  arm(store, 'session-null')
  let nextCalls = 0
  const decision = await prestep.handle(
    { agent, messages: [claimedMessage('请整理书稿目录')] },
    () => { nextCalls += 1; return Promise.resolve({ kind: 'enter', messages: [] }) },
  )
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(nextCalls, 1)
  assert.deepEqual(appended, [])
})

test('a reapplied pre-step after disarm is a normal turn', async () => {
  const { prestep, store } = fixture()
  const { agent, appended } = fakeAgent('session-once')
  arm(store, 'session-once')
  await prestep.handle({ agent, messages: [claimedMessage('只创建一次的任务')] }, () => Promise.resolve({ kind: 'enter', messages: [] }))
  const before = appended.length
  let nextCalls = 0
  const decision = await prestep.handle(
    { agent, messages: [claimedMessage('这条应该正常回复')] },
    () => { nextCalls += 1; return Promise.resolve({ kind: 'enter', messages: [] }) },
  )
  assert.deepEqual(decision, { kind: 'enter', messages: [] })
  assert.equal(nextCalls, 1)
  assert.equal(appended.length, before, 'no second append for an unarmed session')
  assert.equal(store.counts().total, 1)
})
