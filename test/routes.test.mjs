/**
 * Unit tests for the v2 `/dsh-offpeak` HTTP route: trust fence, method/path
 * routing, JSON body limits, controller delegation, and error mapping. No
 * server socket is opened — the handler is driven with fake req/res objects.
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'

import { ControllerError } from '../host/controller.js'
import { MAX_BODY_BYTES, createHandler, isTrustedRequest } from '../host/routes.js'

/**
 * Build a fake `IncomingMessage`.
 *
 * @param {{method?: string, url?: string, headers?: object, body?: string|Buffer}} [options] - request parts.
 * @returns {object} fake request.
 */
function makeReq(options = {}) {
  const body = options.body
  const chunks = body === undefined ? [] : [Buffer.isBuffer(body) ? body : Buffer.from(body)]
  const req = Readable.from(chunks)
  req.method = options.method ?? 'GET'
  req.url = options.url ?? '/dsh-offpeak/snapshot'
  req.headers = { host: '127.0.0.1:49537', ...(options.headers ?? {}) }
  return req
}

/**
 * Build a fake `ServerResponse` collecting status, headers, and body.
 *
 * @returns {object} fake response.
 */
function makeRes() {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      this.headers = headers
    },
    end(chunk) {
      this.body = String(chunk ?? '')
    },
    json() {
      return JSON.parse(this.body)
    },
  }
}

/**
 * Build a handler over a recording controller/engine.
 *
 * @returns {{handler: Function, calls: object[], engineCalls: number[]}} fixture.
 */
function fixture() {
  const calls = []
  const engineCalls = []
  const controller = {
    async snapshot() {
      calls.push(['snapshot'])
      return { ok: true, now: 1, period: { kind: 'offpeak' }, tasks: [], counts: {}, armed: [], stats: {} }
    },
    stats(days) {
      calls.push(['stats', days])
      return { ok: true, days: Number(days ?? 14), lifetime: {}, range: {}, byDay: [], byModel: [], recentRuns: [] }
    },
    async arm(sessionId, workspaceId) {
      calls.push(['arm', sessionId, workspaceId])
      return { ok: true, armed: { sessionId, workspaceId } }
    },
    disarm(sessionId) {
      calls.push(['disarm', sessionId])
      return { ok: true, disarmed: true }
    },
    async startTask(id) {
      calls.push(['startTask', id])
      return { ok: true, task: { id, status: 'running', runTrigger: 'manual' } }
    },
    cancel(id) {
      calls.push(['cancel', id])
      return { ok: true, task: { id, status: 'cancelled' } }
    },
    retry(id) {
      calls.push(['retry', id])
      return { ok: true, task: { id, status: 'queued' } }
    },
    remove(id) {
      calls.push(['remove', id])
      return { ok: true, deleted: true }
    },
    updateTask(id, body) {
      calls.push(['updateTask', id, body])
      return { ok: true, task: { id } }
    },
    move(id, direction) {
      calls.push(['move', id, direction])
      return { ok: true, taskIds: [id] }
    },
    updateSettings(body) {
      calls.push(['updateSettings', body])
      return { ok: true, settings: { autoRun: false } }
    },
  }
  const engine = {
    async tickNow() {
      engineCalls.push(Date.now())
    },
  }
  const logger = { warn() {} }
  const handler = createHandler({ controller, engine, logger })
  return { handler, calls, engineCalls }
}

/**
 * Run one request through the handler.
 *
 * @param {Function} handler - route handler.
 * @param {object} req - fake request.
 * @returns {Promise<object>} fake response.
 */
async function request(handler, req) {
  const res = makeRes()
  await handler(req, res)
  return res
}

test('isTrustedRequest accepts loopback same-origin callers only', () => {
  const trusted = [
    { headers: { host: '127.0.0.1:49537' } },
    { headers: { host: 'localhost:49537', origin: 'http://localhost:49537' } },
    { headers: { host: '127.0.0.1:49537', origin: 'http://127.0.0.1:49537' } },
    { headers: { host: '[::1]:49537' } },
    { headers: { host: '127.0.0.1', origin: 'http://127.0.0.1:80' } },
    { headers: { host: '127.0.0.1:49537', origin: 'http://127.0.0.1:49537', 'sec-fetch-site': 'same-origin' } },
  ]
  for (const req of trusted) assert.equal(isTrustedRequest(req), true, JSON.stringify(req.headers))
  const untrusted = [
    { headers: {} },
    { headers: { host: '0.0.0.0:49537' } },
    { headers: { host: 'evil.example:49537' } },
    { headers: { host: '127.0.0.1:49537', origin: 'http://evil.example' } },
    { headers: { host: '127.0.0.1:49537', origin: 'http://127.0.0.1:49538' } },
    { headers: { host: '127.0.0.1:49537', origin: 'null' } },
    { headers: { host: '127.0.0.1:49537', 'sec-fetch-site': 'cross-site' } },
    { headers: { host: '127.0.0.1:49537', origin: 'not a url' } },
  ]
  for (const req of untrusted) assert.equal(isTrustedRequest(req), false, JSON.stringify(req.headers))
})

test('GET /snapshot returns the controller snapshot', async () => {
  const { handler, calls } = fixture()
  const res = await request(handler, makeReq())
  assert.equal(res.statusCode, 200)
  assert.deepEqual(res.json().ok, true)
  assert.deepEqual(calls, [['snapshot']])
})

test('GET /stats forwards the days window', async () => {
  const { handler, calls } = fixture()
  const res = await request(handler, makeReq({ url: '/dsh-offpeak/stats?days=7' }))
  assert.equal(res.statusCode, 200)
  assert.equal(res.json().days, 7)
  assert.deepEqual(calls, [['stats', '7']])
  const defaulted = await request(handler, makeReq({ url: '/dsh-offpeak/stats' }))
  assert.equal(defaulted.statusCode, 200)
  assert.deepEqual(calls[1], ['stats', undefined])
})

test('cross-site requests are rejected with 403 before touching the controller', async () => {
  const { handler, calls } = fixture()
  const res = await request(handler, makeReq({ headers: { origin: 'http://evil.example', 'sec-fetch-site': 'cross-site' } }))
  assert.equal(res.statusCode, 403)
  assert.equal(res.json().ok, false)
  assert.deepEqual(calls, [])
})

test('POST /sessions/:id/arm and /disarm delegate with the decoded id', async () => {
  const { handler, calls } = fixture()
  const arm = await request(handler, makeReq({
    method: 'POST',
    url: '/dsh-offpeak/sessions/session%2D123/arm',
    body: JSON.stringify({ workspaceId: 'ws-1' }),
  }))
  assert.equal(arm.statusCode, 200)
  assert.deepEqual(calls, [['arm', 'session-123', 'ws-1']])
  const disarm = await request(handler, makeReq({ method: 'POST', url: '/dsh-offpeak/sessions/session-123/disarm' }))
  assert.equal(disarm.statusCode, 200)
  assert.deepEqual(calls[1], ['disarm', 'session-123'])
})

test('task action routes decode the id and forward the body', async () => {
  const { handler, calls } = fixture()
  const cases = [
    ['/dsh-offpeak/tasks/t%2D123/start', undefined, ['startTask', 't-123']],
    ['/dsh-offpeak/tasks/t-123/cancel', undefined, ['cancel', 't-123']],
    ['/dsh-offpeak/tasks/t-123/retry', undefined, ['retry', 't-123']],
    ['/dsh-offpeak/tasks/t-123/delete', undefined, ['remove', 't-123']],
    ['/dsh-offpeak/tasks/t-123/update', { title: '新' }, ['updateTask', 't-123', { title: '新' }]],
    ['/dsh-offpeak/tasks/t-123/move', { direction: 'up' }, ['move', 't-123', 'up']],
  ]
  for (const [url, body, expected] of cases) {
    calls.length = 0
    const res = await request(handler, makeReq({
      method: 'POST',
      url,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }))
    assert.equal(res.statusCode, 200, url)
    assert.deepEqual(calls, [expected], url)
  }
})

test('POST /settings forwards the partial settings object', async () => {
  const { handler, calls } = fixture()
  const res = await request(handler, makeReq({
    method: 'POST',
    url: '/dsh-offpeak/settings',
    body: JSON.stringify({ autoRun: false }),
  }))
  assert.equal(res.statusCode, 200)
  assert.deepEqual(calls, [['updateSettings', { autoRun: false }]])
})

test('POST /tick runs one scheduler pass and returns a fresh snapshot', async () => {
  const { handler, calls, engineCalls } = fixture()
  const res = await request(handler, makeReq({ method: 'POST', url: '/dsh-offpeak/tick' }))
  assert.equal(res.statusCode, 200)
  assert.equal(engineCalls.length, 1)
  assert.deepEqual(calls, [['snapshot']])
  const payload = res.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.snapshot.now, 1)
})

test('removed v1 endpoints are gone (POST /tasks, /run-now)', async () => {
  const { handler, calls } = fixture()
  for (const url of ['/dsh-offpeak/tasks', '/dsh-offpeak/tasks/t-1/run-now']) {
    const res = await request(handler, makeReq({ method: 'POST', url, body: '{}' }))
    assert.equal(res.statusCode, 404, url)
    assert.equal(res.json().ok, false)
  }
  assert.deepEqual(calls, [])
})

test('unknown routes and methods return JSON 404s', async () => {
  const { handler } = fixture()
  for (const req of [
    makeReq({ method: 'GET', url: '/dsh-offpeak/nope' }),
    makeReq({ method: 'GET', url: '/dsh-offpeak/tasks' }),
    makeReq({ method: 'POST', url: '/dsh-offpeak/snapshot' }),
    makeReq({ method: 'DELETE', url: '/dsh-offpeak/tasks/t-1/cancel' }),
  ]) {
    const res = await request(handler, req)
    assert.equal(res.statusCode, 404, `${req.method} ${req.url}`)
    assert.equal(res.json().ok, false)
  }
})

test('malformed JSON and malformed ids answer 400', async () => {
  const { handler, calls } = fixture()
  const badJson = await request(handler, makeReq({ method: 'POST', url: '/dsh-offpeak/settings', body: '{oops' }))
  assert.equal(badJson.statusCode, 400)
  assert.match(badJson.json().error, /合法 JSON/)
  const badId = await request(handler, makeReq({ method: 'POST', url: '/dsh-offpeak/tasks/%E0%A4%A/cancel' }))
  assert.equal(badId.statusCode, 400)
  assert.match(badId.json().error, /id 无效/)
  assert.deepEqual(calls, [])
})

test('oversized bodies are rejected with 413', async () => {
  const { handler } = fixture()
  const huge = 'x'.repeat(MAX_BODY_BYTES + 10)
  const res = await request(handler, makeReq({ method: 'POST', url: '/dsh-offpeak/settings', body: huge }))
  assert.equal(res.statusCode, 413)
  assert.equal(res.json().ok, false)
})

test('controller errors keep their status and message; other errors become 500', async () => {
  const failingController = {
    async snapshot() {
      throw new ControllerError('任务不存在', 404)
    },
    updateSettings() {
      throw new Error('kaboom')
    },
  }
  const handlerWithErrors = createHandler({
    controller: failingController,
    engine: { async tickNow() {} },
    logger: { warn() {} },
  })
  const notFound = await request(handlerWithErrors, makeReq())
  assert.equal(notFound.statusCode, 404)
  assert.deepEqual(notFound.json(), { ok: false, error: '任务不存在' })
  const internal = await request(handlerWithErrors, makeReq({ method: 'POST', url: '/dsh-offpeak/settings', body: '{}' }))
  assert.equal(internal.statusCode, 500)
  assert.equal(internal.json().ok, false)
  assert.match(internal.json().error, /内部错误/)
})
