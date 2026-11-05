#!/usr/bin/env node
/**
 * Prove the creation turn leaves a loadable session log.
 *
 * The interceptor claims the user's task message and rejects the step, so no
 * model call happens. The old release additionally appended that message to the
 * session log, which put a `user/message` before the Agent loop's protected
 * `system/message` — a log the next launch refuses to open. This script drives
 * the real Host code against the installed DSH `Session` and the installed
 * format validator, and asserts the log restores after the creation turn and
 * again after the execution turn.
 *
 * Usage:
 *   node scripts/verify-session-log-safety.mjs \
 *     --dsh "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar.unpacked/dsh"
 *
 * The path must be a DSH checkout or an extracted `app.asar` that exposes
 * `node_modules/@deepseek-ai/dsh-session` and `…/dsh-session-format-v3-to-v4`.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { createStore } from '../host/store.js'
import { createController } from '../host/controller.js'
import { createPrestep } from '../host/prestep.js'
import { executionMessageFor } from '../host/runner.js'

/**
 * Parse `--dsh <path>`.
 *
 * @param {string[]} argv - process arguments.
 * @returns {string} DSH package root.
 */
function parseArgs(argv) {
  const index = argv.indexOf('--dsh')
  if (index === -1 || typeof argv[index + 1] !== 'string') {
    console.error('usage: verify-session-log-safety.mjs --dsh <dsh-package-root>')
    process.exit(2)
  }
  return path.resolve(argv[index + 1])
}

const dshRoot = parseArgs(process.argv.slice(2))
const sessionEntry = path.join(dshRoot, 'node_modules/@deepseek-ai/dsh-session/lib/index.js')
const formatEntry = path.join(dshRoot, 'node_modules/@deepseek-ai/dsh-session-format-v3-to-v4/lib/index.js')
for (const entry of [sessionEntry, formatEntry]) {
  if (!fs.existsSync(entry)) {
    console.error(`missing DSH package entry: ${entry}`)
    process.exit(2)
  }
}
const { Session, KNOWN_SESSION_EVENT_TYPES } = await import(pathToFileURL(sessionEntry).href)
const { restoreReleasedV4Artifact } = await import(pathToFileURL(formatEntry).href)

/**
 * Restore one event log the way the persistence backend does on load.
 *
 * @param {object} header - logical v4 header.
 * @param {object[]} events - stored events.
 * @returns {object} adopted Session.
 */
function load(header, events) {
  const restored = restoreReleasedV4Artifact({ header, events: events.slice(), inheritedEventCount: 0 }, KNOWN_SESSION_EVENT_TYPES)
  return Session.create(header.id, restored.events, header)
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-log-safety-'))
const logger = { warn() {}, info() {} }
const store = createStore({ dataFile: path.join(dir, 'queue.json'), logger, now: () => 1000 })
const engine = { tickNow: async () => {}, activeCount: () => 0, cancelTask: () => false, startTask: async () => null }
const guidance = { register: () => true, unregister() {} }
const controller = createController({
  store,
  engine,
  guidance,
  logger,
  now: () => 1000,
  services: { modelCatalog: async () => ({}), workspaces: () => [], defaultCwd: () => '/abs/work', sessionTitleFor: () => undefined },
})
const prestep = createPrestep({ ctx: { get: () => undefined, on: () => () => {} }, store, guidance, controller, logger })

// Turn 1 — a brand-new conversation, the task submitted, the step rejected.
const session = Session.create('session-log-safety', [], { version: 4, id: 'session-log-safety', createdAt: 1000, cwd: path.join(dir, 'work'), isSeeded: false, delegationDepth: 0 })
store.armSession('session-log-safety', 'ws-1')
session.append('turn/start', { turn: 1 })
const claimed = [{ id: 'm-1', role: 'user', content: [{ type: 'text', text: '修复底部胶囊宽度，并看看历史加载失败' }], source: { kind: 'user', rpcId: 'r1', clientTimeZone: 'Asia/Shanghai' } }]
const decision = await prestep.handle({ agent: { session }, messages: claimed }, () => Promise.resolve({ kind: 'enter', messages: claimed }))
session.append('turn/end', { turn: 1, reason: { kind: 'blocked' } })
if (decision.kind !== 'reject') throw new Error('expected the creation step to be rejected (zero model call)')
const afterCreation = load(session.header, session.log)
if (afterCreation.log.some((event) => event.type === 'user/message')) throw new Error('the creation message must not reach the session log')
console.log(`creation turn: ${afterCreation.log.length} events, surface ${afterCreation.surface.nodes.length} → loadable`)

// Turn 2 — the executor wakes the conversation with the task content.
const task = store.listTasks()[0]
session.append('turn/start', { turn: 2 })
session.append('step/start', { turn: 2, step: 1 })
session.append('system/message', { turn: 2, step: 1, message: { id: 'sys-1', role: 'system', content: [{ type: 'text', text: 'system prompt' }], source: { kind: 'system-prompt' } } }, { surfaceOp: 'append' })
session.append('user/message', executionMessageFor(task, 'offpeak', 'm-wake'), { surfaceOp: 'append' })
session.append('step/end', { turn: 2, step: 1 })
session.append('turn/end', { turn: 2, reason: { kind: 'completed' } })
const afterRun = load(session.header, session.log)
console.log(`execution turn: ${afterRun.log.length} events, surface ${afterRun.surface.nodes.length} → loadable`)

const wake = afterRun.log.find((event) => event.type === 'user/message' && event.surfaceOp === 'append')
if (wake === undefined || !wake.data.content[0].text.includes('修复底部胶囊宽度')) throw new Error('the execution message must carry the task text')
console.log('task text reaches the model through the execution message; no surface write came from the plugin')
