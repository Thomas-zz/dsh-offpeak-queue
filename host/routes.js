/**
 * HTTP surface of the off-peak queue (`/dsh-offpeak` prefix route, v2).
 *
 * The Host enforces a loopback Host/Origin trust fence before any business
 * logic: only a same-origin page served by this DSH instance may call the
 * route. Bodies are bounded JSON; every reply is JSON with a top-level `ok`.
 *
 * @module @zayn_/dsh-offpeak-queue/host/routes
 */

import { ControllerError } from './controller.js'

/** Prefix route claimed by this plugin. */
export const ROUTE = '/dsh-offpeak'

/** Largest JSON request body this route accepts. */
export const MAX_BODY_BYTES = 256 * 1024

/** `POST /sessions/:id/(arm|disarm)` path pattern. */
const SESSION_ACTION_PATTERN = /^\/dsh-offpeak\/sessions\/([^/]+)\/(arm|disarm)$/

/** `POST /tasks/:id/(start|cancel|retry|delete|update|move)` path pattern. */
const TASK_ACTION_PATTERN = /^\/dsh-offpeak\/tasks\/([^/]+)\/(start|cancel|retry|delete|update|move)$/

/**
 * Thrown when a request body exceeds {@link MAX_BODY_BYTES}.
 */
class BodyTooLargeError extends Error {
  /** @param {string} message - description. */
  constructor(message) {
    super(message)
    this.name = 'BodyTooLargeError'
    this.code = 'BODY_TOO_LARGE'
  }
}

/**
 * Thrown when a request body is not valid JSON.
 */
class InvalidJsonError extends Error {
  /** @param {string} message - description. */
  constructor(message) {
    super(message)
    this.name = 'InvalidJsonError'
    this.code = 'INVALID_JSON'
  }
}

/**
 * Whether a request comes from the local page (same-origin loopback).
 * Mirrors the Host/Origin trust fence the built-in connection service applies:
 * a browser page on this machine is the only caller we accept.
 *
 * @param {import('node:http').IncomingMessage} req - HTTP request.
 * @returns {boolean} true when the request may be served.
 */
export function isTrustedRequest(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false
  if (req.headers['sec-fetch-site'] === 'cross-site') return false
  const origin = req.headers.origin
  if (origin === undefined) return true
  try {
    const originUrl = new URL(origin)
    if (!isLoopbackHostname(originUrl.hostname)) return false
    return normalizedPort(originUrl) === normalizedPort(hostUrl)
  } catch {
    return false
  }
}

/**
 * 127/8, localhost and [::1] are the same local machine.
 *
 * @param {string} hostname - URL hostname.
 * @returns {boolean} whether the hostname is a loopback name.
 */
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true
  const parts = hostname.split('.')
  return parts.length === 4 && parts[0] === '127'
    && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
}

/**
 * WHATWG default-port normalization for Host/Origin comparison.
 *
 * @param {URL} url - parsed URL.
 * @returns {string} effective port.
 */
function normalizedPort(url) {
  if (url.port !== '') return url.port
  return url.protocol === 'https:' ? '443' : '80'
}

/**
 * Write one JSON response.
 *
 * @param {import('node:http').ServerResponse} res - response to complete.
 * @param {number} status - HTTP status.
 * @param {unknown} value - JSON value.
 * @returns {void}
 */
export function replyJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

/**
 * Read a bounded JSON request body.
 *
 * @param {import('node:http').IncomingMessage} req - request to read.
 * @returns {Promise<unknown>} parsed JSON, or undefined for an empty body.
 * @throws {BodyTooLargeError|InvalidJsonError} on over-long or malformed bodies.
 */
export async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError('请求体过大')
    chunks.push(chunk)
  }
  if (size === 0) return undefined
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text === '') return undefined
  try {
    return JSON.parse(text)
  } catch {
    throw new InvalidJsonError('请求体不是合法 JSON')
  }
}

/**
 * Decode one URL path segment as an opaque id.
 *
 * @param {string} segment - encoded path segment.
 * @returns {string} decoded id.
 * @throws {ControllerError} when the segment is malformed.
 */
function decodeId(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    throw new ControllerError('id 无效', 400)
  }
}

/**
 * Build the prefix-route handler bound to the controller and scheduler.
 *
 * @param {{controller: object, engine: {tickNow: Function}, logger: {warn: Function}}} dependencies - request dependencies.
 * @returns {(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void>} route handler.
 */
export function createHandler(dependencies) {
  const { controller, engine, logger } = dependencies

  /**
   * Dispatch one trusted request to the controller.
   *
   * @param {import('node:http').IncomingMessage} req - HTTP request.
   * @param {import('node:http').ServerResponse} res - HTTP response.
   * @returns {Promise<void>} resolves after the response completed.
   */
  async function dispatch(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    if (req.method === 'GET' && pathname === `${ROUTE}/snapshot`) {
      replyJson(res, 200, await controller.snapshot())
      return
    }
    if (req.method === 'GET' && pathname === `${ROUTE}/stats`) {
      replyJson(res, 200, controller.stats(url.searchParams.get('days') ?? undefined))
      return
    }
    if (req.method !== 'POST') {
      replyJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${pathname}` })
      return
    }
    const sessionMatch = SESSION_ACTION_PATTERN.exec(pathname)
    if (sessionMatch !== null) {
      const sessionId = decodeId(sessionMatch[1])
      const body = (await readJsonBody(req)) ?? {}
      if (sessionMatch[2] === 'arm') {
        replyJson(res, 200, await controller.arm(sessionId, body.workspaceId, { taskId: body.taskId }))
        return
      }
      replyJson(res, 200, controller.disarm(sessionId))
      return
    }
    const taskMatch = TASK_ACTION_PATTERN.exec(pathname)
    if (taskMatch !== null) {
      const id = decodeId(taskMatch[1])
      const action = taskMatch[2]
      if (action === 'start') {
        await readJsonBody(req)
        replyJson(res, 200, await controller.startTask(id))
        return
      }
      if (action === 'cancel' || action === 'retry' || action === 'delete') {
        await readJsonBody(req)
        if (action === 'cancel') replyJson(res, 200, controller.cancel(id))
        else if (action === 'retry') replyJson(res, 200, controller.retry(id))
        else replyJson(res, 200, controller.remove(id))
        return
      }
      const body = (await readJsonBody(req)) ?? {}
      if (action === 'update') {
        replyJson(res, 200, controller.updateTask(id, body))
        return
      }
      replyJson(res, 200, controller.move(id, body.direction))
      return
    }
    if (pathname === `${ROUTE}/settings`) {
      const body = (await readJsonBody(req)) ?? {}
      replyJson(res, 200, controller.updateSettings(body))
      return
    }
    if (pathname === `${ROUTE}/tick`) {
      await readJsonBody(req)
      await engine.tickNow()
      replyJson(res, 200, { ok: true, snapshot: await controller.snapshot() })
      return
    }
    replyJson(res, 404, { ok: false, error: `未知接口 ${req.method} ${pathname}` })
  }

  /**
   * Prefix-route handler: trust fence, JSON errors, and dispatch.
   *
   * @param {import('node:http').IncomingMessage} req - HTTP request.
   * @param {import('node:http').ServerResponse} res - HTTP response.
   * @returns {Promise<void>} resolves after the response completed.
   */
  return async function handler(req, res) {
    if (!isTrustedRequest(req)) {
      replyJson(res, 403, { ok: false, error: 'forbidden' })
      return
    }
    try {
      await dispatch(req, res)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (error instanceof BodyTooLargeError) {
        replyJson(res, 413, { ok: false, error: '请求体过大' })
        return
      }
      if (error instanceof InvalidJsonError) {
        replyJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
        return
      }
      if (error instanceof ControllerError) {
        replyJson(res, error.status, { ok: false, error: error.message })
        return
      }
      try {
        logger.warn(`offpeak-queue: 请求处理失败：${message}`)
      } catch {
        /* ignored */
      }
      replyJson(res, 500, { ok: false, error: `内部错误：${message.slice(0, 300)}` })
    }
  }
}
