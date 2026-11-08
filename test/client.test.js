'use strict'

const { test } = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const { Vexo } = require('..')

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
      res.end(JSON.stringify(next.body || { success: true, code: 200, data: { accepted, dropped: [] } }))
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
  assert.match(request.headers['user-agent'], /^vexo-node\//)
  const [identify, capture] = request.body.batch
  assert.deepEqual({ type: identify.type, distinctId: identify.distinctId, traits: identify.traits },
    { type: 'identify', distinctId: 'user_1', traits: { plan: 'pro' } })
  assert.equal(capture.type, 'capture')
  assert.equal(capture.event, 'purchase')
  assert.deepEqual(capture.properties, { amount: 42 })
  assert.ok(!Number.isNaN(Date.parse(capture.timestamp)))
  assert.notEqual(identify.messageId, capture.messageId)
  assert.deepEqual(errors, [])
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
