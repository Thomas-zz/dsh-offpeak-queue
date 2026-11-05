/**
 * Repair stored session logs that an earlier plugin release damaged.
 *
 * Releases up to 0.2.0 wrote the intercepted creation message into the session
 * log itself (`session.append('user/message', …, {surfaceOp:'append'})`) so a
 * zero-call creation turn would still show the task text. That write happens
 * before any model step, so it becomes the log's first model-visible event.
 * The session format requires the first model-visible event to be a protected
 * `system/message` (only the Agent loop writes one, inside `step()`), so the
 * stored log fails to load on the next launch:
 *
 *     SessionFormatError: system/message requires a protected first surface head
 *
 * The current release no longer writes that event, and this module heals the
 * logs the old one left behind: the stray leading message is moved to the
 * first protected `system/message` (keeping the user's task text and its
 * attachments in the conversation history), sequence numbers are renumbered,
 * every event-to-event reference is remapped, and the previous file is kept as
 * a `.bak-<stamp>` sibling.
 *
 * @module dsh-offpeak-queue/host/repair
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { execFileSync } from 'node:child_process'

/** Event types that join the model-visible surface. */
const SURFACE_TYPES = new Set(['system/message', 'user/message', 'assistant/message', 'tool/result'])

/** Single-event sequence references carried in event payloads. */
const SEQ_FIELDS = new Set(['headerSeq', 'startSeq', 'endSeq'])

/** Sequence-reference lists carried in event payloads. */
const SEQ_LIST_FIELDS = new Set(['messageSeqs', 'sourceEventSeqs', 'shadowedSeqs'])

/** Marker used to report an unmappable reference from the remap walk. */
const UNMAPPED = Symbol('unmapped')

/** Suffix of the sibling file kept for a repaired log. */
const BACKUP_SUFFIX = 'bak'

/**
 * Whether one event joins the model-visible surface.
 *
 * @param {object} event - stored event.
 * @returns {boolean} true for append-origin or replacement surface events.
 */
function isSurfaceEvent(event) {
  return typeof event === 'object' && event !== null && SURFACE_TYPES.has(event.type) && event.surfaceOp !== undefined
}

/**
 * Deep-clone one JSON value.
 *
 * @param {unknown} value - JSON value.
 * @returns {unknown} detached copy.
 */
function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

/**
 * Remap every event-to-event reference inside one payload.
 *
 * @param {unknown} value - payload subtree.
 * @param {Map<number, number>} mapping - old seq → new seq (kept events only).
 * @param {number} beforeSeq - new seq of the referencing event.
 * @param {string} where - dotted path, used in the failure reason.
 * @returns {{ok: true, value: unknown}|{ok: false, reason: string}} remapped value.
 */
function remapReferences(value, mapping, beforeSeq, where) {
  if (Array.isArray(value)) {
    const out = []
    for (const [index, entry] of value.entries()) {
      const result = remapReferences(entry, mapping, beforeSeq, `${where}[${index}]`)
      if (!result.ok) return result
      out.push(result.value)
    }
    return { ok: true, value: out }
  }
  if (typeof value !== 'object' || value === null) return { ok: true, value }
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (SEQ_FIELDS.has(key) && Number.isInteger(entry)) {
      const next = mapping.get(entry)
      if (next === undefined || next >= beforeSeq) return { ok: false, reason: `${where}.${key} points at a moved or later event` }
      out[key] = next
      continue
    }
    if (SEQ_LIST_FIELDS.has(key) && Array.isArray(entry)) {
      const list = []
      for (const [index, seq] of entry.entries()) {
        if (!Number.isInteger(seq)) return { ok: false, reason: `${where}.${key}[${index}] is not a sequence number` }
        const next = mapping.get(seq)
        if (next === undefined) {
          // A title may simply stop citing a message that moved past it; every
          // other reference is structural and cannot be dropped.
          if (key === 'messageSeqs') continue
          return { ok: false, reason: `${where}.${key}[${index}] points at a moved or dropped event` }
        }
        if (next >= beforeSeq) {
          if (key === 'messageSeqs') continue
          return { ok: false, reason: `${where}.${key}[${index}] no longer precedes its event` }
        }
        list.push(next)
      }
      out[key] = list
      continue
    }
    const result = remapReferences(entry, mapping, beforeSeq, `${where}.${key}`)
    if (!result.ok) return result
    out[key] = result.value
  }
  return { ok: true, value: out }
}

/**
 * Plan the repair of one stored session log.
 *
 * @param {object[]} events - stored events in log order (seq 0…n-1).
 * @returns {{events: object[], moved: number[], dropped: number[]}|null} the
 *   repaired log, or null when the log already satisfies the head rule.
 */
export function planSessionLogRepair(events) {
  if (!Array.isArray(events) || events.length === 0) return null
  const headIndex = events.findIndex((event) => event?.type === 'system/message' && event?.surfaceOp === 'append')

  // Collect surface appends that reached the log before the protected head.
  // Only a leading run of user messages is this corruption; an assistant or
  // tool node first means something else is wrong, and guessing would be worse
  // than leaving the log alone.
  const strays = []
  const limit = headIndex === -1 ? events.length : headIndex
  for (let index = 0; index < limit; index += 1) {
    if (!isSurfaceEvent(events[index])) continue
    if (events[index].type !== 'user/message') return null
    strays.push(index)
  }
  if (strays.length === 0) return null
  // Without any protected head the leading messages cannot be replayed later:
  // they can only be dropped, and only when nothing else is on the surface.
  if (headIndex === -1) {
    const straySet = new Set(strays)
    const remaining = events.filter((event, index) => !straySet.has(index) && isSurfaceEvent(event))
    if (remaining.length > 0) return null
  }

  const straySet = new Set(strays)
  const ordered = []
  for (const [index, event] of events.entries()) {
    if (straySet.has(index)) continue
    ordered.push(event)
    if (index === headIndex) for (const stray of strays) ordered.push(events[stray])
  }

  // Sequences are positional: renumber first, then rewrite the references the
  // kept events carry between each other.
  const mapping = new Map()
  for (const [index, event] of ordered.entries()) {
    if (Number.isInteger(event.seq)) mapping.set(event.seq, index)
  }
  const repaired = []
  for (const [index, event] of ordered.entries()) {
    const copy = clone(event)
    copy.seq = index
    const remapped = remapReferences(copy.data ?? {}, mapping, index, 'data')
    if (!remapped.ok) return null
    copy.data = remapped.value
    if (copy.sourceEventSeqs !== undefined) {
      const result = remapReferences({ sourceEventSeqs: copy.sourceEventSeqs }, mapping, index, 'event')
      if (!result.ok) return null
      copy.sourceEventSeqs = result.value.sourceEventSeqs
    }
    if (typeof copy.surfaceOp === 'object' && copy.surfaceOp !== null) {
      const result = remapReferences(copy.surfaceOp, mapping, index, 'surfaceOp')
      if (!result.ok) return null
      copy.surfaceOp = result.value
    }
    repaired.push(copy)
  }
  return {
    events: repaired,
    moved: strays.map((index) => events[index].seq),
    dropped: headIndex === -1 ? strays.map((index) => events[index].seq) : [],
  }
}

/**
 * Whether one log's first model-visible event is the protected system head.
 *
 * @param {object[]} events - renumbered events.
 * @returns {boolean} true when the head rule holds.
 */
export function hasProtectedHead(events) {
  for (const [index, event] of events.entries()) {
    if (event?.seq !== index) return false
    if (!isSurfaceEvent(event)) continue
    return event.type === 'system/message' && event.surfaceOp === 'append'
  }
  return true
}

/**
 * Split one stored log text into its header line and its events.
 *
 * @param {string} text - decoded log (JSON lines).
 * @returns {{header: object|null, events: object[]}} parsed parts.
 */
export function parseLogText(text) {
  const lines = String(text).split('\n').filter((line) => line.trim() !== '')
  const parsed = lines.map((line) => JSON.parse(line))
  const header = parsed.length > 0 && parsed[0]?.type === 'session' ? parsed[0] : null
  return { header, events: header === null ? parsed : parsed.slice(1) }
}

/**
 * Repair one decoded log.
 *
 * @param {string} text - decoded log text.
 * @returns {{text: string, moved: number[], dropped: number[]}|null} repaired
 *   text, or null when there is nothing to repair.
 */
export function repairLogText(text) {
  const { header, events } = parseLogText(text)
  const plan = planSessionLogRepair(events)
  if (plan === null) return null
  if (!hasProtectedHead(plan.events)) return null
  const lines = []
  if (header !== null) lines.push(JSON.stringify(header))
  for (const event of plan.events) lines.push(JSON.stringify(event))
  return { text: `${lines.join('\n')}\n`, moved: plan.moved, dropped: plan.dropped }
}

/** Zstandard frame magic, little-endian as stored. */
const ZSTD_MAGIC = 0xfd2fb528

/** Zstandard skippable-frame magic range (0x184D2A50…0x184D2A5F). */
const ZSTD_SKIPPABLE_MASK = 0xfffffff0
const ZSTD_SKIPPABLE = 0x184d2a50

/**
 * Locate the frames of a concatenated Zstandard container.
 *
 * The persistence backend appends one frame per flush, so a stored log is a
 * container of frames rather than a single stream; `zlib.zstdDecompressSync`
 * decodes only the first one. Frame boundaries come from the header and block
 * structure without decoding blocks.
 *
 * @param {Buffer} buffer - stored file bytes.
 * @returns {Array<{start: number, end: number}>} frame ranges in file order.
 * @throws when the container is structurally invalid.
 */
export function splitZstdFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset + 4 <= buffer.length) {
    const magic = buffer.readUInt32LE(offset)
    if ((magic & ZSTD_SKIPPABLE_MASK) === ZSTD_SKIPPABLE) {
      if (offset + 8 > buffer.length) throw new Error('truncated skippable frame')
      const size = buffer.readUInt32LE(offset + 4)
      offset += 8 + size
      continue
    }
    if (magic !== ZSTD_MAGIC) throw new Error(`bad frame magic at byte ${offset}`)
    const start = offset
    offset += 4
    if (offset >= buffer.length) throw new Error('truncated frame header')
    const descriptor = buffer[offset]
    offset += 1
    const contentSizeFlag = descriptor >> 6
    const singleSegment = (descriptor >> 5) & 1
    const checksum = (descriptor >> 2) & 1
    const dictionaryFlag = descriptor & 3
    if (singleSegment === 0) offset += 1
    offset += [0, 1, 2, 4][dictionaryFlag]
    offset += singleSegment === 1 ? [1, 2, 4, 8][contentSizeFlag] : [0, 2, 4, 8][contentSizeFlag]
    for (;;) {
      if (offset + 3 > buffer.length) throw new Error('truncated block header')
      const header = buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
      offset += 3
      const last = header & 1
      const type = (header >> 1) & 3
      const size = header >> 3
      offset += type === 1 ? 1 : size
      if (last === 1) break
    }
    if (checksum === 1) offset += 4
    if (offset > buffer.length) throw new Error('truncated frame')
    frames.push({ start, end: offset })
  }
  if (frames.length === 0) throw new Error('no Zstandard frame found')
  return frames
}

/**
 * Decode one stored log file (single or multi frame).
 *
 * @param {string} file - absolute log path.
 * @returns {string} decoded UTF-8 text.
 * @throws when the file is not decodable.
 */
function decodeLogFile(file) {
  const raw = fs.readFileSync(file)
  if (!file.endsWith('.zstd')) return raw.toString('utf8')
  if (typeof zlib.zstdDecompressSync !== 'function') {
    return execFileSync('zstd', ['-dc', file], { maxBuffer: 1024 * 1024 * 512 }).toString('utf8')
  }
  const parts = []
  for (const frame of splitZstdFrames(raw)) {
    parts.push(zlib.zstdDecompressSync(raw.subarray(frame.start, frame.end)))
  }
  return Buffer.concat(parts).toString('utf8')
}

/**
 * Encode one stored log file as a single Zstandard frame.
 *
 * @param {string} file - absolute log path (decides compression).
 * @param {string} text - decoded log text.
 * @returns {Buffer} bytes to write.
 */
function encodeLogFile(file, text) {
  const body = Buffer.from(text, 'utf8')
  if (!file.endsWith('.zstd')) return body
  if (typeof zlib.zstdCompressSync === 'function') return zlib.zstdCompressSync(body)
  return execFileSync('zstd', ['-q', '-c'], { input: body, maxBuffer: 1024 * 1024 * 512 })
}

/**
 * Repair one stored session log in place, keeping a backup of the original.
 *
 * @param {string} file - absolute log path.
 * @param {{logger?: {info: Function, warn: Function}, dryRun?: boolean}} [options] - sink and mode.
 * @returns {{file: string, moved: number[], dropped: number[], wrote: boolean}} outcome.
 */
export function repairLogFile(file, options = {}) {
  const logger = options.logger ?? console
  const warn = (line) => {
    try {
      logger.warn(line)
    } catch {
      /* ignored */
    }
  }
  const before = fs.statSync(file)
  const text = decodeLogFile(file)
  const repaired = repairLogText(text)
  if (repaired === null) return { file, moved: [], dropped: [], wrote: false }
  if (options.dryRun === true) return { file, moved: repaired.moved, dropped: repaired.dropped, wrote: false }
  // Another process may still be appending to this log. Rewriting it then
  // would drop those events for good, so any change during the read cancels
  // the repair; the next launch finds the same corruption again.
  const after = fs.statSync(file)
  if (after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
    warn(`offpeak-queue: 会话日志在修复期间被写入，已跳过（${file}）`)
    return { file, moved: [], dropped: [], wrote: false }
  }
  const backup = `${file}.${BACKUP_SUFFIX}-${Date.now()}`
  try {
    fs.copyFileSync(file, backup)
    const temp = `${file}.repair-${process.pid}`
    fs.writeFileSync(temp, encodeLogFile(file, repaired.text))
    fs.renameSync(temp, file)
  } catch (error) {
    warn(`offpeak-queue: 修复会话日志失败（${file}）：${error instanceof Error ? error.message : String(error)}`)
    return { file, moved: [], dropped: [], wrote: false }
  }
  try {
    logger.info?.(`offpeak-queue: 已修复会话日志 ${file}（移动 ${repaired.moved.length} 条、删除 ${repaired.dropped.length} 条，备份 ${backup}）`)
  } catch {
    /* ignored */
  }
  return { file, moved: repaired.moved, dropped: repaired.dropped, wrote: true }
}

/**
 * Resolve the stored-log path of one session.
 *
 * @param {unknown} persistence - `sessionPersistence` service.
 * @param {{id: string, cwd?: string}} meta - session identity.
 * @returns {string|null} absolute path when resolvable.
 */
function logPathFor(persistence, meta) {
  try {
    const located = persistence?.locate?.({ id: meta.id, cwd: meta.cwd })
    if (typeof located?.path === 'string' && located.path !== '') return located.path
  } catch {
    /* fall through to the root scan */
  }
  return null
}

/**
 * Every stored log under one sessions root, bounded so a large history cannot
 * stall the boot.
 *
 * @param {string} root - sessions root directory.
 * @param {number} limit - maximum files inspected.
 * @returns {string[]} absolute log paths.
 */
function listSessionLogs(root, limit) {
  const files = []
  let projects = []
  try {
    projects = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
  } catch {
    return files
  }
  for (const project of projects) {
    if (files.length >= limit) break
    const projectDir = path.join(root, project.name)
    let sessions = []
    try {
      sessions = fs.readdirSync(projectDir, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    } catch {
      continue
    }
    for (const session of sessions) {
      if (files.length >= limit) break
      for (const name of ['session.v4.jsonl.zstd', 'session.v4.jsonl']) {
        const candidate = path.join(projectDir, session.name, name)
        if (fs.existsSync(candidate)) {
          files.push(candidate)
          break
        }
      }
    }
  }
  return files
}

/**
 * Repair every damaged session log reachable at start-up.
 *
 * Runs before any conversation is opened, so a repaired file is the one the
 * session loads later. Sessions that are live in this process are skipped: the
 * in-memory log and the file must not diverge.
 *
 * @param {{
 *   persistence?: object,
 *   tasks?: object[],
 *   sessions?: {get?: Function},
 *   logger?: {info: Function, warn: Function},
 *   limit?: number,
 * }} options - repair inputs.
 * @returns {{repaired: string[]}} repaired log paths.
 */
export function repairStoredSessions(options = {}) {
  const logger = options.logger ?? console
  const repaired = []
  const persistence = options.persistence
  if (persistence === undefined || persistence === null) return { repaired }
  const skipped = new Set()
  try {
    for (const task of Array.isArray(options.tasks) ? options.tasks : []) {
      if (typeof task?.sourceSessionId === 'string') skipped.add(task.sourceSessionId)
    }
  } catch {
    /* ignored */
  }
  const isLive = (id) => {
    try {
      return options.sessions?.get?.(id) !== undefined
    } catch {
      return false
    }
  }

  const seen = new Set()
  const repairOne = (file) => {
    if (seen.has(file)) return
    seen.add(file)
    const id = path.basename(path.dirname(file))
    if (isLive(id)) return
    try {
      const outcome = repairLogFile(file, { logger })
      if (outcome.wrote) repaired.push(file)
    } catch (error) {
      try {
        logger.warn(`offpeak-queue: 检查会话日志失败（${file}）：${error instanceof Error ? error.message : String(error)}`)
      } catch {
        /* ignored */
      }
    }
  }

  // Targeted pass: the sessions the queue knows it created.
  for (const task of Array.isArray(options.tasks) ? options.tasks : []) {
    const id = typeof task?.sourceSessionId === 'string' ? task.sourceSessionId : ''
    if (id === '') continue
    const file = logPathFor(persistence, { id, cwd: typeof task.cwd === 'string' ? task.cwd : undefined })
    if (file !== null && fs.existsSync(file)) repairOne(file)
  }

  // Sweep pass: a deleted task record must not strand its conversation.
  const root = (() => {
    try {
      return typeof persistence.root === 'string' ? persistence.root : null
    } catch {
      return null
    }
  })()
  if (root !== null) {
    for (const file of listSessionLogs(root, options.limit ?? 400)) repairOne(file)
  }
  return { repaired }
}
