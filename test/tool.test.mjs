/**
 * Unit tests for the v2 `offpeak_queue` agent tool: raw JSON-schema
 * registration shape, the supported-keyword subset, session binding, 本会话
 * marking, every action (including `run_current`), markdown output, and
 * readable Chinese errors for user mistakes.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createStore } from '../host/store.js'
import { createController } from '../host/controller.js'
import { TOOL_NAME, createTool, registerTool } from '../host/tool.js'

/** Off-peak reference instant: Tuesday 2026-11-03 13:00 Beijing. */
const NOW = Date.parse('2026-11-03T13:00:00+08:00')

/** Keywords the DSH raw-schema subset enforces/supports. */
const ALLOWED_SCHEMA_KEYS = new Set([
  'type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'oneOf',
  'description', 'title', 'default', 'examples',
])

/**
 * Recursively assert a schema uses only the supported raw JSON-schema subset.
 *
 * @param {object} schema - schema node.
 * @param {string} label - path label for failures.
 * @returns {void}
 */
function assertSupportedSchema(schema, label = 'schema') {
  assert.equal(typeof schema, 'object', `${label} is an object`)
  assert.ok(!Array.isArray(schema), `${label} is not an array`)
  for (const key of Object.keys(schema)) assert.ok(ALLOWED_SCHEMA_KEYS.has(key), `${label} uses supported keyword ${key}`)
  if (schema.type !== undefined) {
    assert.ok(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'].includes(schema.type), `${label}.type is a scalar type`)
  }
  if (schema.properties !== undefined) {
    for (const [name, child] of Object.entries(schema.properties)) assertSupportedSchema(child, `${label}.properties.${name}`)
  }
  if (schema.items !== undefined) assertSupportedSchema(schema.items, `${label}.items`)
  if (schema.oneOf !== undefined) {
    assert.ok(Array.isArray(schema.oneOf))
    schema.oneOf.forEach((child, index) => assertSupportedSchema(child, `${label}.oneOf[${index}]`))
  }
}

/**
 * Build a tool over a real controller with stubbed Host services.
 *
 * @returns {object} fixture.
 */
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-tool-'))
  const store = createStore({ dataFile: path.join(dir, 'queue.json'), logger: { warn() {}, info() {} }, now: () => NOW })
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
    async startTask(id, trigger = 'manual') {
      const started = store.startRun(id, trigger)
      if (started === null) return store.getTask(id)
      return store.getTask(id)
    },
  }
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
  const controller = createController({
    store,
    engine,
    guidance,
    logger: { warn() {}, info() {} },
    now: () => NOW,
    services: {
      modelCatalog: async () => ({ default: null, groups: [], failures: [] }),
      workspaces: () => [],
      defaultCwd: () => '/abs/default',
      sessionTitleFor: () => undefined,
    },
  })
  const tool = createTool({ controller, guidance })
  return { tool, controller, store, engine, guidance, dir }
}

/**
 * Build a fake tool execution context.
 *
 * @param {string|null} [sessionId] - calling session id (null for no agent).
 * @returns {{exec: object, guidanceCalls: object[]}} fake exec.
 */
function fakeExec(sessionId = 'session-caller') {
  const agent = sessionId === null ? undefined : {
    session: { id: sessionId },
    ctx: {
      systemPrompt: {
        section(section) {
          return () => {}
        },
      },
    },
  }
  return { exec: { agent } }
}

/**
 * Create one queued task bound to an arbitrary session through the pre-step path.
 *
 * @param {object} controller - controller fixture.
 * @param {string} sessionId - source session id.
 * @param {string} text - task description.
 * @returns {object} task.
 */
function seedTask(controller, sessionId, text) {
  return controller.createTaskFromCreation({ sessionId, workspaceId: 'ws-1', text, title: text, cwd: '/abs/work' })
}

test('registerTool registers the raw definition under the documented name', () => {
  const registered = []
  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
  }
  const { controller, guidance } = fixture()
  const dispose = registerTool(ctx, controller, guidance)
  assert.equal(typeof dispose, 'function')
  assert.equal(registered.length, 1)
  assert.equal(registered[0].name, TOOL_NAME)
  assert.equal(TOOL_NAME, 'offpeak_queue')
})

test('the tool schema stays inside the supported subset and exposes run_current', () => {
  const { tool } = fixture()
  assert.equal(tool.name, 'offpeak_queue')
  assert.equal(tool.parameters.type, 'object')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.equal(tool.parameters.additionalProperties, false)
  assert.deepEqual(tool.parameters.properties.action.enum, [
    'add', 'list', 'update', 'cancel', 'retry', 'run_now', 'run_current', 'delete',
  ])
  assertSupportedSchema(tool.parameters, 'parameters')
  assertSupportedSchema(tool.output.schema, 'output.schema')
  assert.match(tool.description, /run_current/)
  assert.deepEqual(tool.output.render({}, { text: '你好' }), [{ type: 'text', text: '你好' }])
})

test('add binds the calling conversation, registers guidance, and confirms the position', async () => {
  const { tool, controller, store, guidance } = fixture()
  const { exec } = fakeExec('session-7e43')
  const value = await tool.execute({ action: 'add', title: '整理书稿目录', prompt: '请整理书稿目录并输出 markdown' }, exec)
  assert.match(value.text, /已加入闲时队列（DeepSeek，第 1 个）/)
  assert.match(value.text, /模型：DeepSeek/)
  assert.match(value.text, /闲时开始后自动执行/)
  assert.match(value.text, /任务 id：`t-/)
  const task = store.listTasks()[0]
  assert.equal(task.sourceSessionId, 'session-7e43')
  assert.equal(task.sessionId, 'session-7e43')
  assert.equal(task.title, '整理书稿目录')
  assert.equal(guidance.registered.length, 1)
  assert.equal(guidance.registered[0].agent.session.id, 'session-7e43')
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.ok(controller.listSummary(1).tasks.length === 1)
})

test('add stays honest when the task already started (no bogus position)', async () => {
  const { controller, store, guidance } = fixture()
  const racing = {
    ...controller,
    addTaskFromTool(sessionId, input) {
      const result = controller.addTaskFromTool(sessionId, input)
      store.startRun(result.task.id, 'offpeak')
      return result
    },
  }
  const tool = createTool({ controller: racing, guidance })
  const { exec } = fakeExec()
  const value = await tool.execute({ action: 'add', prompt: '请只回复：收到' }, exec)
  assert.doesNotMatch(value.text, /第 0 个/)
  assert.doesNotMatch(value.text, /第 \d+ 个/)
  assert.match(value.text, /已加入闲时队列，任务已开始执行。/)
  assert.match(value.text, /任务 id：`t-/)
})

test('add requires a calling conversation', async () => {
  const { tool } = fixture()
  const { exec } = fakeExec(null)
  await assert.rejects(() => tool.execute({ action: 'add', prompt: '任务' }, exec), /add 需要在会话中调用/)
})

test('list marks tasks bound to the calling conversation', async () => {
  const { tool, controller } = fixture()
  const { exec } = fakeExec('session-caller')
  await tool.execute({ action: 'add', prompt: '本会话任务' }, exec)
  seedTask(controller, 'session-other', '别人的任务')
  const listed = await tool.execute({ action: 'list' }, exec)
  assert.match(listed.text, /共 2 个任务：等待 2/)
  assert.match(listed.text, /本会话任务（本会话）/)
  assert.match(listed.text, /别人的任务（别人的任务）/)
  assert.equal((listed.text.match(/（本会话）/g) ?? []).length, 1, 'only the bound task is marked')
  assert.match(listed.text, /\| 状态 \| 模型 \| 标题 \| 时间 \| 任务 id \|/)
  assert.match(listed.text, /^DeepSeek 当前：/m)
  assert.match(listed.text, /^GLM 当前：/m)
})

test('update / cancel / retry / delete drive the controller', async () => {
  const { tool, controller, store } = fixture()
  const { exec } = fakeExec()
  const added = await tool.execute({ action: 'add', prompt: '原始任务' }, exec)
  const id = /任务 id：`([^`]+)`/.exec(added.text)[1]
  const updated = await tool.execute({ action: 'update', id, title: '新标题' }, exec)
  assert.match(updated.text, /已更新任务「新标题」/)
  const cancelled = await tool.execute({ action: 'cancel', id }, exec)
  assert.match(cancelled.text, /已取消任务/)
  assert.equal(store.getTask(id).status, 'cancelled')
  const retried = await tool.execute({ action: 'retry', id }, exec)
  assert.match(retried.text, /已重新加入队列任务/)
  assert.equal(store.getTask(id).status, 'queued')
  const deleted = await tool.execute({ action: 'delete', id }, exec)
  assert.match(deleted.text, /已删除任务/)
  assert.equal(store.getTask(id), null)
  assert.ok(controller)
})

test('run_now immediately starts a named queued task', async () => {
  const { tool, controller, store } = fixture()
  const { exec } = fakeExec()
  const task = seedTask(controller, 'session-caller', '指定任务')
  const started = await tool.execute({ action: 'run_now', id: task.id }, exec)
  assert.match(started.text, /已开始执行任务「指定任务」/)
  assert.equal(store.getTask(task.id).status, 'running')
  assert.equal(store.getTask(task.id).runTrigger, 'manual')
  await assert.rejects(() => tool.execute({ action: 'run_now', id: task.id }, exec), /只有等待中的任务可以立即执行/)
})

test('run_current executes the queued task bound to the calling conversation', async () => {
  const { tool, controller, store } = fixture()
  const startCalls = []
  const recording = {
    ...controller,
    async startTask(id, options) {
      startCalls.push({ id, options })
      return controller.startTask(id, options)
    },
  }
  const recordingTool = createTool({ controller: recording, guidance: { register: () => true } })
  const { exec } = fakeExec('session-caller')
  seedTask(controller, 'session-caller', '本会话的任务')
  const value = await recordingTool.execute({ action: 'run_current' }, exec)
  assert.deepEqual(startCalls, [{ id: store.listTasks()[0].id, options: { waitForIdle: false } }], 'run_current queues behind the current turn')
  void tool
  assert.match(value.text, /已开始执行本会话的闲时任务「本会话的任务」/)
  assert.match(value.text, /将在本条回复结束后继续/)
  const task = store.listTasks()[0]
  assert.equal(task.status, 'running')
  assert.equal(task.runTrigger, 'manual')
  await assert.rejects(() => tool.execute({ action: 'run_current' }, exec), /正在执行中/)
  const other = fakeExec('session-other')
  await assert.rejects(() => tool.execute({ action: 'run_current' }, other.exec), /没有等待执行的闲时任务/)
})

test('user mistakes become readable Chinese errors instead of crashes', async () => {
  const { tool } = fixture()
  const { exec } = fakeExec()
  await assert.rejects(() => tool.execute({ action: 'cancel' }, exec), /cancel 操作需要提供任务 id/)
  await assert.rejects(() => tool.execute({ action: 'run_now', id: 't-missing' }, exec), /任务不存在/)
  await assert.rejects(() => tool.execute({ action: 'add', prompt: '   ' }, exec), /不能为空/)
  await assert.rejects(() => tool.execute({ action: 'wat' }, exec), /未知操作/)
})
