'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { Vexo } = require('..')
const { version } = require('../package.json')

// A local API that records each batch request and answers with the next scripted response.
async function fakeApi (responses = []) {
  const requests = []
  const server = http.createServer((req, res) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: JSON.parse(body) })
      const next = responses.shift() || { status: 200 }
      const accepted = requests.at(-1).body.batch.length
      res.writeHead(next.status, { 'Content-Type': 'application/json', ...next.headers })
      res.end(next.raw ?? JSON.stringify(next.body || { success: true, code: 200, data: { accepted, dropped: [] } }))
    })
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const host = `http://127.0.0.1:${server.address().port}`
  return { host, requests, close: () => new Promise((resolve) => server.close(resolve)) }
}

function client (host, options = {}) {
  const errors = []
  const vexo = new Vexo('test-key', { host, flushInterval: 60000, onError: (e) => errors.push(e), ...options })
  return { vexo, errors }
}

test('sends queued messages as one batch with the API key', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.identify({ distinctId: 'user_1', traits: { plan: 'pro' } })
  vexo.capture({ distinctId: 'user_1', event: 'purchase', properties: { amount: 42 } })
  await vexo.shutdown()

  assert.equal(api.requests.length, 1)
  const [request] = api.requests
  assert.equal(request.method, 'POST')
  assert.equal(request.url, '/v1/batch')
  assert.equal(request.headers['x-api-key'], 'test-key')
  assert.equal(request.headers['user-agent'], `vexo-node/${version}`)
  const [identify, capture] = request.body.batch
  assert.deepEqual({ type: identify.type, distinctId: identify.distinctId, traits: identify.traits },
    { type: 'identify', distinctId: 'user_1', traits: { plan: 'pro' } })
  assert.equal(capture.type, 'capture')
  assert.equal(capture.event, 'purchase')
  assert.deepEqual(capture.properties, { amount: 42 })
  assert.ok(Number.isInteger(capture.timestamp) && Math.abs(capture.timestamp - Date.now()) < 5000)
  assert.notEqual(identify.messageId, capture.messageId)
  assert.deepEqual(errors, [])
})

test('sends timestamps as integer epoch ms and a caller\'s messageId unchanged', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo } = client(api.host)

  vexo.capture({ distinctId: 'u', event: 'a', timestamp: new Date('2026-11-07T12:00:00Z'), messageId: 'order-1' })
  vexo.capture({ distinctId: 'u', event: 'b', timestamp: 1794052800000.9 })
  vexo.capture({ distinctId: 'u', event: 'c', timestamp: '2026-11-07T12:00:00+02:00' })
  await vexo.shutdown()

  const [date, number, iso] = api.requests[0].body.batch
  assert.deepEqual([date.timestamp, number.timestamp, iso.timestamp], [1794052800000, 1794052800000, '2026-11-07T12:00:00+02:00'])
  assert.equal(date.messageId, 'order-1')
  assert.match(number.messageId, /^[0-9a-f-]{36}$/)
})

test('counts a 2xx it cannot parse as accepted', async (t) => {
  const api = await fakeApi([{ status: 200, raw: '<html>ok</html>' }])
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.capture({ distinctId: 'u', event: 'a' })
  await vexo.shutdown()
  assert.equal(api.requests.length, 1)
  assert.deepEqual(errors, [])
})

test('the ES module entry exports the same client as the CommonJS build', async () => {
  const esm = await import('../index.mjs')
  assert.deepEqual(Object.getOwnPropertyNames(esm.Vexo.prototype), Object.getOwnPropertyNames(Vexo.prototype))
})

test('flushes when the queue reaches flushAt', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo } = client(api.host, { flushAt: 2 })

  vexo.capture({ distinctId: 'u', event: 'a' })
  vexo.capture({ distinctId: 'u', event: 'b' })
  await vexo.pending
  assert.equal(api.requests.length, 1)
  assert.equal(api.requests[0].body.batch.length, 2)
  await vexo.shutdown()
})

test('flushes on the interval', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo } = client(api.host, { flushInterval: 20 })

  vexo.capture({ distinctId: 'u', event: 'a' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  await vexo.pending
  assert.equal(api.requests.length, 1)
  await vexo.shutdown()
})

test('flushInterval 0 starts no timer, so only flush() sends', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo } = client(api.host, { flushInterval: 0 })

  vexo.capture({ distinctId: 'u', event: 'a' })
  await new Promise((resolve) => setTimeout(resolve, 100))
  assert.equal(api.requests.length, 0)
  await vexo.flush()
  assert.equal(api.requests.length, 1)
  await vexo.shutdown()
})

test('shutdown removes the client\'s beforeExit listener', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const before = process.listenerCount('beforeExit')
  const { vexo } = client(api.host)
  assert.equal(process.listenerCount('beforeExit'), before + 1)
  await vexo.shutdown()
  assert.equal(process.listenerCount('beforeExit'), before)
})

test('retries 503 and 429 with the same batch', async (t) => {
  const api = await fakeApi([
    { status: 503, headers: { 'Retry-After': '0' }, body: { success: false } },
    { status: 429, headers: { 'Retry-After': '0' }, body: { success: false } }
  ])
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.capture({ distinctId: 'u', event: 'a' })
  await vexo.shutdown()

  assert.equal(api.requests.length, 3)
  assert.equal(api.requests[2].body.batch[0].messageId, api.requests[0].body.batch[0].messageId)
  assert.deepEqual(errors, [])
})

test('does not retry a 4xx and reports it', async (t) => {
  const api = await fakeApi([{ status: 401, body: { success: false, message: 'Permission denied' } }])
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.capture({ distinctId: 'u', event: 'a' })
  await vexo.shutdown()

  assert.equal(api.requests.length, 1)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].status, 401)
  assert.equal(errors[0].batch.length, 1)
})

test('gives up after maxRetries', async (t) => {
  const api = await fakeApi(Array.from({ length: 5 }, () => ({ status: 500, headers: { 'Retry-After': '0' } })))
  t.after(api.close)
  const { vexo, errors } = client(api.host, { maxRetries: 2 })

  vexo.capture({ distinctId: 'u', event: 'a' })
  await vexo.shutdown()

  assert.equal(api.requests.length, 3)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].status, 500)
})

test('reports the messages the server dropped', async (t) => {
  const api = await fakeApi([{
    status: 200,
    body: { success: true, code: 200, data: { accepted: 1, dropped: [{ index: 1, reason: 'Json node cannot exceed 65536 length' }] } }
  }])
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.capture({ distinctId: 'u', event: 'ok' })
  vexo.capture({ distinctId: 'u', event: 'too_big' })
  await vexo.shutdown()

  assert.equal(errors.length, 1)
  assert.equal(errors[0].dropped[0].message.event, 'too_big')
  assert.match(errors[0].dropped[0].reason, /65536/)
})

test('rejects messages without a distinctId and after shutdown', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.capture({ event: 'a' })
  await vexo.shutdown()
  vexo.capture({ distinctId: 'u', event: 'late' })

  assert.equal(api.requests.length, 0)
  assert.equal(errors.length, 2)
})

test('drops messages once the queue is full', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo, errors } = client(api.host, { maxQueueSize: 1 })

  vexo.capture({ distinctId: 'u', event: 'a' })
  vexo.capture({ distinctId: 'u', event: 'b' })
  await vexo.shutdown()

  assert.equal(api.requests[0].body.batch.length, 1)
  assert.match(errors[0].message, /queue is full/)
})

test('treats capture(null) and identify(null) as a reported no-op', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.capture(null)
  vexo.identify(null)
  vexo.capture()
  await vexo.shutdown()

  assert.equal(api.requests.length, 0)
  assert.equal(errors.length, 3)
})

test('drops only the message that cannot be serialized', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.capture({ distinctId: 'u', event: 'ok' })
  vexo.capture({ distinctId: 'u', event: 'big_int', properties: { amount: 10n } })
  await vexo.shutdown()

  assert.equal(api.requests.length, 1)
  assert.deepEqual(api.requests[0].body.batch.map((m) => m.event), ['ok'])
  assert.equal(errors.length, 1)
  assert.match(errors[0].message, /JSON/)
})

test('splits batches so each request body stays under 5 MB', async (t) => {
  const api = await fakeApi()
  t.after(api.close)
  const { vexo, errors } = client(api.host)
  const blob = 'x'.repeat(2 * 1024 * 1024)

  for (let i = 0; i < 3; i++) {
    vexo.capture({ distinctId: 'u', event: `e${i}`, properties: { blob } })
  }
  await vexo.shutdown()

  assert.deepEqual(api.requests.map((r) => r.body.batch.length), [2, 1])
  assert.deepEqual(errors, [])
})

test('sends again only the messages the server reports as failed', async (t) => {
  const api = await fakeApi([{
    status: 200,
    headers: {},
    body: { success: true, code: 200, data: { accepted: 1, dropped: [], failed: [{ index: 1, reason: 'Storing failed; retry' }] } }
  }])
  t.after(api.close)
  const { vexo, errors } = client(api.host)

  vexo.capture({ distinctId: 'a', event: 'stored' })
  vexo.capture({ distinctId: 'b', event: 'failed_once' })
  const started = Date.now()
  await vexo.shutdown()

  assert.equal(api.requests.length, 2)
  assert.deepEqual(api.requests[1].body.batch.map((m) => m.event), ['failed_once'])
  assert.equal(api.requests[1].body.batch[0].messageId, api.requests[0].body.batch[1].messageId)
  assert.ok(Date.now() - started < 3000)
  assert.deepEqual(errors, [])
})

test('stops retrying the next batches once one batch used up its retries', async (t) => {
  const api = await fakeApi(Array.from({ length: 20 }, () => ({ status: 500, headers: { 'Retry-After': '0' } })))
  t.after(api.close)
  const { vexo, errors } = client(api.host, { flushAt: 1, maxRetries: 2 })

  for (let i = 0; i < 3; i++) {
    vexo.capture({ distinctId: 'u', event: `e${i}` })
  }
  await vexo.shutdown()

  // 3 attempts for the first batch, then 1 for each of the others.
  assert.equal(api.requests.length, 5)
  assert.equal(errors.length, 3)
})

test('shutdown gives up at shutdownTimeout when the API is unreachable', async () => {
  const port = await freePort()
  const { vexo, errors } = client(`http://127.0.0.1:${port}`, { flushAt: 1, timeout: 500, shutdownTimeout: 1000 })

  for (let i = 0; i < 5; i++) {
    vexo.capture({ distinctId: 'u', event: `e${i}` })
  }
  const started = Date.now()
  await vexo.shutdown()

  assert.ok(Date.now() - started < 2000, `shutdown took ${Date.now() - started} ms`)
  assert.ok(errors.some((e) => /deadline/.test(e.message)))
})

// A port with nothing listening, so connections are refused.
async function freePort () {
  const server = net.createServer()
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise((resolve) => server.close(resolve))
  return port
}
