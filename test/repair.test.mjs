/**
 * Unit tests for the stored-log repair (`host/repair.js`): the head rule the
 * old release violated, the renumbering/remap of a repaired log, the frame
 * scanner for the concatenated Zstandard container, and the file-level repair
 * with its backup.
 *
 * Every test writes into a fresh `mkdtemp` directory.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import {
  hasProtectedHead,
  planSessionLogRepair,
  repairLogFile,
  repairStoredSessions,
  repairLogText,
  splitZstdFrames,
} from '../host/repair.js'

/** A session header line as the persistence backend stores it. */
const HEADER = { type: 'session', version: 4, id: 'session-cut', createdAt: 1, cwd: '/abs/work', isSeeded: false, delegationDepth: 0 }

/**
 * Silent logger that records warnings.
 *
 * @returns {{warn: Function, info: Function, warnings: string[], infos: string[]}} logger stub.
 */
function captureLogger() {
  const warnings = []
  const infos = []
  return {
    warnings,
    infos,
    warn(message) {
      warnings.push(String(message))
    },
    info(message) {
      infos.push(String(message))
    },
  }
}

/**
 * Build the damaged log an old release left behind: the creation message lands
 * on the surface before any model step wrote the protected system head.
 *
 * @param {{head?: boolean}} [options] - omit the system head to model a session
 *   that never executed.
 * @returns {object[]} events.
 */
function damagedEvents(options = {}) {
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: '看看这个 UI' }] }, surfaceOp: 'append' },
    { type: 'session/title', seq: 2, time: 2, data: { title: '闲时任务 · 看看这个 UI', messageSeqs: [], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'blocked' } } },
    { type: 'turn/start', seq: 4, time: 4, data: { turn: 2 } },
    { type: 'step/start', seq: 5, time: 4, data: { turn: 2, step: 1 } },
  ]
  if (options.head !== false) {
    events.push({ type: 'system/message', seq: 6, time: 4, data: { turn: 2, step: 1, message: { role: 'system', content: [{ type: 'text', text: 'prompt' }] } }, surfaceOp: 'append' })
  }
  events.push(
    { type: 'user/message', seq: events.length, time: 5, data: { content: [{ type: 'text', text: '开始执行' }] }, surfaceOp: 'append' },
    { type: 'assistant/message', seq: events.length + 1, time: 6, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '好' }] } }, surfaceOp: 'append' },
    { type: 'tool/result', seq: events.length + 2, time: 7, data: { message: { toolCallId: 'c1' } }, surfaceOp: { startSeq: events.length + 1, endSeq: events.length + 1 }, sourceEventSeqs: [events.length + 1] },
  )
  return events
}

test('a log that already starts with the protected system head is left alone', () => {
  const events = [
    { type: 'step/start', seq: 0, time: 1, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 1, time: 1, data: { turn: 1, step: 1, message: { role: 'system', content: [] } }, surfaceOp: 'append' },
    { type: 'user/message', seq: 2, time: 2, data: { content: [] }, surfaceOp: 'append' },
  ]
  assert.equal(planSessionLogRepair(events), null)
  assert.equal(repairLogText(`${JSON.stringify(HEADER)}\n${events.map((event) => JSON.stringify(event)).join('\n')}\n`), null)
})

test('the stray leading message is moved behind the protected head and sequences are renumbered', () => {
  const events = damagedEvents()
  const plan = planSessionLogRepair(events)
  assert.notEqual(plan, null)
  assert.deepEqual(plan.moved, [1])
  assert.deepEqual(plan.dropped, [])
  assert.equal(plan.events.length, events.length, 'moving keeps every event')
  assert.equal(hasProtectedHead(plan.events), true)
  assert.deepEqual(plan.events.map((event) => event.seq), plan.events.map((_, index) => index))
  assert.equal(plan.events[5].type, 'system/message', 'the head keeps its position')
  assert.equal(plan.events[6].type, 'user/message', 'the task text now follows the head')
  assert.equal(plan.events[6].data.content[0].text, '看看这个 UI')
})

test('references to moved events are remapped, and a dropped reference aborts the repair', () => {
  const moved = damagedEvents()
  moved.push({ type: 'tool/result', seq: moved.length, time: 8, data: { message: { toolCallId: 'c2' } }, surfaceOp: { startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] })
  const plan = planSessionLogRepair(moved)
  assert.notEqual(plan, null)
  assert.deepEqual(plan.events.at(-1).sourceEventSeqs, [6], 'a structural reference follows the moved node')

  const dropped = damagedEvents({ head: false })
  dropped.push({ type: 'tool/result', seq: dropped.length, time: 8, data: { message: { toolCallId: 'c2' } }, surfaceOp: { startSeq: 1, endSeq: 1 }, sourceEventSeqs: [1] })
  assert.equal(planSessionLogRepair(dropped), null, 'a node that would be dropped cannot be referenced')

  const ok = damagedEvents()
  ok.push({ type: 'session/title', seq: ok.length, time: 9, data: { title: 't', messageSeqs: [1], source: { kind: 'llm' } } })
  const titled = planSessionLogRepair(ok)
  assert.notEqual(titled, null)
  assert.deepEqual(titled.events.at(-1).data.messageSeqs, [6], 'a title citation follows the moved message')

  // The dropped case cannot cite a node the log no longer holds, so the
  // citation is removed instead of the whole repair.
  const trimmed = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: '看看这个 UI' }] }, surfaceOp: 'append' },
    { type: 'session/title', seq: 2, time: 3, data: { title: 't', messageSeqs: [1], source: { kind: 'llm' } } },
  ]
  const droppedTitle = planSessionLogRepair(trimmed)
  assert.notEqual(droppedTitle, null)
  assert.deepEqual(droppedTitle.events.at(-1).data.messageSeqs, [])
})

test('a log with no system head at all drops the stray message instead of moving it', () => {
  // A session that was armed, queued a task, and never executed: the only
  // model-visible event in the log is the stray creation message.
  const events = [
    { type: 'turn/start', seq: 0, time: 1, data: { turn: 1 } },
    { type: 'user/message', seq: 1, time: 2, data: { content: [{ type: 'text', text: '看看这个 UI' }] }, surfaceOp: 'append' },
    { type: 'session/title', seq: 2, time: 2, data: { title: '闲时任务 · 看看这个 UI', messageSeqs: [], source: { kind: 'user' } } },
    { type: 'turn/end', seq: 3, time: 3, data: { turn: 1, reason: { kind: 'blocked' } } },
  ]
  const plan = planSessionLogRepair(events)
  assert.notEqual(plan, null)
  assert.deepEqual(plan.moved, [1])
  assert.deepEqual(plan.dropped, [1])
  assert.equal(plan.events.length, events.length - 1)
  assert.equal(hasProtectedHead(plan.events), true)
  assert.equal(plan.events.every((event, index) => event.seq === index), true)
})

test('a leading assistant node is left untouched rather than guessed at', () => {
  const events = [
    { type: 'assistant/message', seq: 0, time: 1, data: {}, surfaceOp: 'append' },
    { type: 'step/start', seq: 1, time: 1, data: { turn: 1, step: 1 } },
    { type: 'system/message', seq: 2, time: 1, data: { turn: 1, step: 1, message: {} }, surfaceOp: 'append' },
  ]
  assert.equal(planSessionLogRepair(events), null)
})

test('splitZstdFrames locates every frame of a concatenated container', () => {
  const first = zlib.zstdCompressSync(Buffer.from('{"type":"session"}\n'))
  const second = zlib.zstdCompressSync(Buffer.from('{"type":"turn/start","seq":0}\n'))
  const container = Buffer.concat([first, second])
  const frames = splitZstdFrames(container)
  assert.equal(frames.length, 2)
  const decoded = frames.map((frame) => zlib.zstdDecompressSync(container.subarray(frame.start, frame.end))).join('')
  assert.equal(decoded, '{"type":"session"}\n{"type":"turn/start","seq":0}\n')
})

test('repairLogFile rewrites a damaged stored log and keeps the original as a backup', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-repair-'))
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const text = `${JSON.stringify(HEADER)}\n${damagedEvents().map((event) => JSON.stringify(event)).join('\n')}\n`
  fs.writeFileSync(file, Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(text.split('\n').slice(0, 2).join('\n') + '\n')),
    zlib.zstdCompressSync(Buffer.from(text.split('\n').slice(2).join('\n'))),
  ]))
  const logger = captureLogger()
  const outcome = repairLogFile(file, { logger })
  assert.equal(outcome.wrote, true)
  assert.deepEqual(outcome.moved, [1])
  const backups = fs.readdirSync(dir).filter((name) => name.includes('.bak-'))
  assert.equal(backups.length, 1, 'the original is preserved')
  const rewritten = zlib.zstdDecompressSync(fs.readFileSync(file)).toString('utf8')
  const lines = rewritten.trim().split('\n').map((line) => JSON.parse(line))
  assert.equal(lines[0].type, 'session')
  assert.equal(lines[1].seq, 0)
  assert.equal(lines[7].type, 'user/message')
  assert.ok(logger.infos.some((line) => line.includes('已修复会话日志')))
  assert.equal(repairLogFile(file, { logger }).wrote, false, 'a repaired log is left alone')
})

test('repairStoredSessions repairs queued-task sessions and skips live ones', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'offpeak-repair-scan-'))
  const root = path.join(dir, 'sessions')
  const project = path.join(root, '--abs-work--')
  const makeLog = (id) => {
    const sessionDir = path.join(project, id)
    fs.mkdirSync(sessionDir, { recursive: true })
    const events = damagedEvents()
    const text = `${JSON.stringify({ ...HEADER, id })}\n${events.map((event) => JSON.stringify(event)).join('\n')}\n`
    fs.writeFileSync(path.join(sessionDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(text)))
    return path.join(sessionDir, 'session.v4.jsonl.zstd')
  }
  const targeted = makeLog('session-targeted')
  const swept = makeLog('session-swept')
  const live = makeLog('session-live')
  const persistence = {
    root,
    locate: (meta) => ({ kind: 'jsonl', path: path.join(project, meta.id, 'session.v4.jsonl.zstd') }),
  }
  const result = repairStoredSessions({
    persistence,
    tasks: [{ sourceSessionId: 'session-targeted' }],
    sessions: { get: (id) => (id === 'session-live' ? {} : undefined) },
    logger: captureLogger(),
  })
  assert.deepEqual(result.repaired.sort(), [targeted, swept].sort())
  const liveText = zlib.zstdDecompressSync(fs.readFileSync(live)).toString('utf8')
  assert.ok(liveText.includes('"seq":1'), 'a live session keeps its file untouched')
})
