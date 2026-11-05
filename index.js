/**
 * Host half of `dsh-offpeak-queue` (v2).
 *
 * Conversation-first off-peak tasks: a conversation is "armed" from the panel,
 * the user's submitted task message is intercepted in the global
 * `agent/pre-step` waterfall (zero model calls), and the queued task later
 * executes in that same conversation. This module wires the persisted store,
 * the in-conversation runner, the scheduler engine, the operation controller,
 * the `/dsh-offpeak` HTTP prefix route, the `offpeak_queue` tool, the
 * session-scoped model guidance, and the creation interceptor. Every
 * registration is owned by a Cordis effect and disposed on unload; `apply`
 * returns a final flush for the data file.
 *
 * @module dsh-offpeak-queue
 */

import { createStore } from './host/store.js'
import { createRunner } from './host/runner.js'
import { createEngine } from './host/engine.js'
import { createController } from './host/controller.js'
import { createHandler, ROUTE } from './host/routes.js'
import { createTool } from './host/tool.js'
import { createGuidance } from './host/guidance.js'
import { createPrestep } from './host/prestep.js'
import { repairStoredSessions } from './host/repair.js'

/** Host services this row needs before it can activate. */
export const inject = ['webServer', 'sessionController', 'sessions', 'tools']

/**
 * Resolve the Host default working directory: the first registered workspace
 * path when the registry is mounted, else the Host process directory.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {string} absolute default working directory.
 */
function resolveDefaultCwd(ctx) {
  try {
    const registry = ctx.get('workspaceRegistry')
    const list = registry?.list?.()
    if (Array.isArray(list) && list.length > 0 && typeof list[0].path === 'string' && list[0].path !== '') {
      return list[0].path
    }
  } catch {
    /* optional service: fall back to the process directory */
  }
  return process.cwd()
}

/**
 * Best-effort session title for a conversation.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {string} sessionId - session id.
 * @returns {string|undefined} current title when the session and service are live.
 */
function currentSessionTitle(ctx, sessionId) {
  try {
    const session = ctx.sessions.get(sessionId)
    if (session === undefined) return undefined
    const titles = ctx.get('sessionTitle')
    const snapshot = titles?.get?.(session)
    return typeof snapshot?.title === 'string' ? snapshot.title : undefined
  } catch {
    return undefined
  }
}

/**
 * Whether a session can receive an execution prompt: live now, or stored and
 * resumable.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {string} sessionId - session id.
 * @returns {Promise<boolean>} resolvability.
 */
async function sessionResolvable(ctx, sessionId) {
  try {
    if (ctx.sessions.get(sessionId) !== undefined) return true
    const persistence = ctx.get('sessionPersistence')
    if (persistence === undefined || typeof persistence.stat !== 'function') return false
    const stat = await persistence.stat(sessionId)
    return stat !== undefined && stat !== null
  } catch {
    return false
  }
}

/**
 * Whether the workspace registry knows one workspace id.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {string} workspaceId - workspace id.
 * @returns {boolean} true when known (or when the registry is unavailable).
 */
function workspaceExists(ctx, workspaceId) {
  try {
    const registry = ctx.get('workspaceRegistry')
    if (registry === undefined || typeof registry.get !== 'function') return true
    return registry.get(workspaceId) !== undefined
  } catch {
    return true
  }
}

/**
 * Whether the workspace registry marks one session archived.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {string} sessionId - session id.
 * @returns {boolean} true when archived.
 */
function isArchivedSession(ctx, sessionId) {
  try {
    const registry = ctx.get('workspaceRegistry')
    const archived = registry?.archivedSessionIds
    return Array.isArray(archived) && archived.includes(sessionId)
  } catch {
    return false
  }
}

/**
 * Resolve the live Agent for one session (used to re-register task guidance).
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {string} sessionId - session id.
 * @returns {object|undefined} live Agent.
 */
function liveAgentFor(ctx, sessionId) {
  try {
    return ctx.get('agents')?.get?.(sessionId)
  } catch {
    return undefined
  }
}

/**
 * Activate the Host half.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @returns {() => void} final cleanup flush hook.
 */
/** Session-log repairs run at most once per process. */
let repairedSessions = false

/**
 * Heal stored session logs an earlier release corrupted, before any
 * conversation is opened.
 *
 * Releases up to 0.2.0 appended the intercepted creation message to the
 * session log, which made the log unreadable on the next launch. The repair is
 * strictly best-effort: it never throws, never touches a live session, and
 * keeps the original file as a backup.
 *
 * @param {import('@deepseek-ai/cordis').Context} ctx - Host plugin context.
 * @param {ReturnType<typeof createStore>} store - queue store.
 * @param {{info: Function, warn: Function}} logger - plugin logger.
 * @returns {string[]} repaired log paths.
 */
function healDamagedSessions(ctx, store, logger) {
  if (repairedSessions) return []
  repairedSessions = true
  try {
    const { repaired } = repairStoredSessions({
      persistence: ctx.get('sessionPersistence'),
      sessions: { get: (sessionId) => ctx.sessions.get(sessionId) },
      tasks: store.listTasks(),
      logger,
    })
    return repaired
  } catch (error) {
    try {
      logger.warn(`offpeak-queue: 会话日志自检失败：${error instanceof Error ? error.message : String(error)}`)
    } catch {
      /* ignored */
    }
    return []
  }
}

export function apply(ctx) {
  const logger = ctx.logger('offpeak-queue')
  const store = createStore({ logger })
  const guidance = createGuidance({ logger })
  const runner = createRunner({ ctx, logger })
  const engine = createEngine({
    store,
    runner,
    logger,
    onRunSettled: (taskId) => guidance.unregister(taskId),
  })
  const controller = createController({
    store,
    engine,
    guidance,
    logger,
    services: {
      modelCatalog: () => ctx.sessionController.modelCatalog(),
      workspaces: () => {
        const registry = ctx.get('workspaceRegistry')
        return registry?.list?.() ?? []
      },
      defaultCwd: () => resolveDefaultCwd(ctx),
      sessionTitleFor: (sessionId) => currentSessionTitle(ctx, sessionId),
      sessionResolvable: (sessionId) => sessionResolvable(ctx, sessionId),
      isArchived: (sessionId) => isArchivedSession(ctx, sessionId),
      workspaceExists: (workspaceId) => workspaceExists(ctx, workspaceId),
      agentFor: (sessionId) => liveAgentFor(ctx, sessionId),
    },
  })
  const prestep = createPrestep({ ctx, store, guidance, controller, logger })

  // Repair damaged session logs on the first macrotask of this process: every
  // service is mounted by then, and the UI has not opened a conversation yet.
  ctx.effect(
    () => {
      const timer = setTimeout(() => {
        healDamagedSessions(ctx, store, logger)
      }, 0)
      timer.unref?.()
      return () => clearTimeout(timer)
    },
    'offpeak-queue: session-log repair',
  )
  ctx.effect(
    () => prestep.install(),
    'offpeak-queue: pre-step creation interceptor',
  )
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: ROUTE, handler: createHandler({ controller, engine, logger }) }),
    'offpeak-queue: HTTP route',
  )
  ctx.effect(
    () => ctx.tools.register(createTool({ controller, guidance })),
    'offpeak-queue: agent tool',
  )
  ctx.effect(
    () => {
      engine.start()
      return async () => {
        await engine.dispose()
        guidance.disposeAll()
        store.dispose()
      }
    },
    'offpeak-queue: scheduler',
  )

  return () => {
    try {
      store.flush()
    } catch {
      /* final flush is best effort */
    }
  }
}
