#!/usr/bin/env node
/**
 * Repair stored session logs damaged by dsh-offpeak-queue ≤ 0.2.0.
 *
 * Those releases appended the intercepted creation message to the session log
 * before any model step wrote the protected `system/message` head, so the log
 * failed to load on the next launch:
 *
 *     SessionFormatError: system/message requires a protected first surface head
 *
 * The plugin now repairs such logs automatically at start-up, before any
 * conversation is opened. This script does the same by hand — for example right
 * after quitting DSH, or to inspect what the repair would move.
 *
 * Usage:
 *   node scripts/repair-session-logs.mjs            # repair everything it finds
 *   node scripts/repair-session-logs.mjs --dry-run  # only report
 *   node scripts/repair-session-logs.mjs --session session-918450d8-…  # one id
 *   node scripts/repair-session-logs.mjs --root /path/to/.dsh/sessions
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { repairLogFile } from '../host/repair.js'

/** Default stored-session root. */
const DEFAULT_ROOT = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'), 'sessions')

/**
 * Parse argv into options.
 *
 * @param {string[]} argv - process arguments.
 * @returns {{root: string, dryRun: boolean, ids: string[]}} options.
 */
function parseArgs(argv) {
  const options = { root: DEFAULT_ROOT, dryRun: false, ids: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--root') options.root = path.resolve(argv[++index] ?? '')
    else if (arg === '--session') options.ids.push(String(argv[++index] ?? ''))
    else if (arg === '--help' || arg === '-h') {
      console.log('usage: repair-session-logs.mjs [--dry-run] [--root <dir>] [--session <id>]…')
      process.exit(0)
    } else throw new Error(`unknown argument: ${arg}`)
  }
  return options
}

/**
 * Every stored log under one sessions root.
 *
 * @param {string} root - sessions root.
 * @returns {string[]} absolute log paths.
 */
function findLogs(root) {
  const files = []
  if (!fs.existsSync(root)) return files
  for (const project of fs.readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory()) continue
    const projectDir = path.join(root, project.name)
    for (const session of fs.readdirSync(projectDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue
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

const options = parseArgs(process.argv.slice(2))
const logs = findLogs(options.root).filter((file) => options.ids.length === 0 || options.ids.some((id) => file.includes(`/${id}/`)))
if (logs.length === 0) {
  console.log(`no stored session log found under ${options.root}`)
  process.exit(0)
}
let repaired = 0
for (const file of logs) {
  const outcome = repairLogFile(file, { dryRun: options.dryRun })
  if (outcome.moved.length === 0 && outcome.dropped.length === 0) continue
  repaired += 1
  const verb = options.dryRun ? 'would repair' : outcome.wrote ? 'repaired' : 'skipped (write failed)'
  console.log(`${verb} ${file} — moved ${outcome.moved.length}, dropped ${outcome.dropped.length}`)
}
console.log(repaired === 0 ? 'nothing to repair' : `${repaired} log(s) ${options.dryRun ? 'need repair' : 'processed'}`)
