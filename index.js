'use strict'

const { randomUUID } = require('node:crypto')
const { version } = require('./package.json')

const DEFAULT_HOST = 'https://api.vexo.co'
// The server rejects a batch of more than 500 messages or a body over 5 MB.
const MAX_BATCH_SIZE = 500
const MAX_BODY_BYTES = 5 * 1024 * 1024
const BATCH_ENVELOPE_BYTES = Buffer.byteLength('{"batch":[]}')
const MAX_BACKOFF_MS = 30000

class Vexo {
  /**
   * @param {string} apiKey your app's Vexo API key
   * @param {object} [options]
   */
  constructor (apiKey, options = {}) {
    if (!apiKey) {
      throw new Error('vexo: an API key is required')
    }
    this.apiKey = apiKey
    this.host = (options.host || DEFAULT_HOST).replace(/\/+$/, '')
    this.flushAt = Math.max(1, Math.min(options.flushAt ?? 100, MAX_BATCH_SIZE))
    this.flushInterval = options.flushInterval ?? 10000
    this.maxRetries = options.maxRetries ?? 3
    this.maxQueueSize = options.maxQueueSize ?? 10000
    this.timeout = options.timeout ?? 10000
    this.shutdownTimeout = options.shutdownTimeout ?? 10000
    this.onError = options.onError || ((error) => console.error(`[vexo] ${error.message}`))

    this.queue = []
    this.closed = false
    this.pending = Promise.resolve()
    // Set by a batch that used up its retries: later batches get one attempt until a request succeeds.
    this.circuitOpen = false
    this.deadline = null
    this.inflight = new Set()
    this.timer = setInterval(() => this.flush(), this.flushInterval)
    this.timer.unref()
    // A script that ends without calling shutdown() still sends what it queued.
    process.once('beforeExit', () => this.shutdown())
  }

  /**
   * Queues an event. `timestamp` (Date, ISO 8601 string or epoch ms) defaults to now. `messageId` defaults to a
   * random UUID; pass your own (an order ID, say) to dedupe across your own retries.
   */
  capture (message) {
    const { distinctId, event, properties, timestamp, messageId } = message || {}
    if (!distinctId || !event) {
      this.onError(new Error('vexo: capture needs a distinctId and an event'))
      return
    }
    this.enqueue({
      type: 'capture',
      distinctId: String(distinctId),
      event: String(event),
      properties: properties || {},
      timestamp: epochMillis(timestamp)
    }, messageId)
  }

  /** Queues an identify: merges `traits` into the person with this distinct id. */
  identify (message) {
    const { distinctId, traits } = message || {}
    if (!distinctId) {
      this.onError(new Error('vexo: identify needs a distinctId'))
      return
    }
    this.enqueue({ type: 'identify', distinctId: String(distinctId), traits: traits || {} })
  }

  /** Sends everything queued. Resolves when the queue is empty; send failures go to onError. */
  flush () {
    this.pending = this.pending.then(() => this.drain())
    return this.pending
  }

  /**
   * Stops the interval timer and sends everything queued, giving up after `shutdownTimeout` ms: what is still queued
   * then is dropped and reported to onError. Call it before your process exits.
   */
  async shutdown () {
    if (!this.closed) {
      this.closed = true
      clearInterval(this.timer)
      this.deadline = Date.now() + this.shutdownTimeout
      setTimeout(() => this.interrupt(), this.shutdownTimeout).unref()
    }
    await this.flush()
  }

  enqueue (message, messageId) {
    if (this.closed) {
      this.onError(new Error('vexo: the client is shut down; message dropped'))
      return
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.onError(new Error('vexo: the queue is full; message dropped'))
      return
    }
    const entry = { message: { ...message, messageId: messageId ? String(messageId) : randomUUID() } }
    try {
      entry.json = JSON.stringify(entry.message)
    } catch (error) {
      this.onError(new Error(`vexo: message dropped, it can't be sent as JSON: ${error.message}`))
      return
    }
    entry.bytes = Buffer.byteLength(entry.json)
    if (entry.bytes + BATCH_ENVELOPE_BYTES > MAX_BODY_BYTES) {
      this.onError(new Error('vexo: message dropped, it is larger than 5 MB'))
      return
    }
    this.queue.push(entry)
    if (this.queue.length >= this.flushAt) {
      this.flush()
    }
  }

  async drain () {
    while (this.queue.length > 0) {
      if (this.deadlinePassed()) {
        const dropped = this.queue.splice(0)
        const error = new Error(`vexo: shutdown deadline reached; ${dropped.length} message(s) dropped`)
        error.batch = dropped.map((entry) => entry.message)
        this.onError(error)
        return
      }
      const batch = this.nextBatch()
      try {
        await this.send(batch)
      } catch (error) {
        error.batch = batch.map((entry) => entry.message)
        this.onError(error)
      }
    }
  }

  // Up to flushAt messages that fit in one request body.
  nextBatch () {
    let bytes = BATCH_ENVELOPE_BYTES
    let count = 0
    while (count < this.queue.length && count < this.flushAt && bytes + this.queue[count].bytes + count <= MAX_BODY_BYTES) {
      bytes += this.queue[count].bytes
      count++
    }
    return this.queue.splice(0, count)
  }

  // POST /v1/batch. Network errors, 429 and 5xx are retried with exponential backoff (or the server's Retry-After);
  // messages the server reports as failed are sent again the same way. Dropped messages are reported, not retried.
  async send (batch) {
    const maxRetries = this.circuitOpen ? 0 : this.maxRetries
    for (let attempt = 0; ; attempt++) {
      let response
      try {
        response = await this.post(`{"batch":[${batch.map((entry) => entry.json).join(',')}]}`)
      } catch (error) {
        if (attempt >= maxRetries || this.deadlinePassed()) {
          this.circuitOpen = true
          throw error
        }
        await this.wait(backoff(attempt))
        continue
      }
      if (response.ok) {
        this.circuitOpen = false
        const result = await responseData(response)
        this.report(batch, result.dropped, 'the server dropped')
        const failed = (result.failed || []).map(({ index }) => batch[index]).filter(Boolean)
        if (failed.length === 0) {
          return
        }
        if (attempt >= maxRetries || this.deadlinePassed()) {
          this.report(batch, result.failed, 'the server could not store')
          return
        }
        batch = failed
        await this.wait(backoff(attempt))
        continue
      }
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt >= maxRetries || this.deadlinePassed()) {
        if (retryable) {
          this.circuitOpen = true
        }
        const error = new Error(`vexo: batch rejected with HTTP ${response.status}: ${await response.text()}`)
        error.status = response.status
        throw error
      }
      await this.wait(retryAfter(response) ?? backoff(attempt))
    }
  }

  async post (body) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('vexo: request timed out')), this.timeout)
    this.inflight.add(controller)
    try {
      return await fetch(`${this.host}/v1/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey, 'User-Agent': `vexo-node/${version}` },
        body,
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
      this.inflight.delete(controller)
    }
  }

  report (batch, results, what) {
    if (results && results.length > 0) {
      const error = new Error(`vexo: ${what} ${results.length} message(s): ${results[0].reason}`)
      error.dropped = results.map(({ index, reason }) => ({ message: batch[index] && batch[index].message, reason }))
      this.onError(error)
    }
  }

  deadlinePassed () {
    return this.deadline !== null && Date.now() >= this.deadline
  }

  // Sleeps, but never past the shutdown deadline.
  wait (ms) {
    const remaining = this.deadline === null ? ms : Math.max(0, this.deadline - Date.now())
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.min(ms, remaining))
      this.wake = () => {
        clearTimeout(timer)
        resolve()
      }
    })
  }

  // At the shutdown deadline: abort the request in flight and end any backoff wait.
  interrupt () {
    this.inflight.forEach((controller) => controller.abort(new Error('vexo: shutdown deadline reached')))
    if (this.wake) {
      this.wake()
    }
  }
}

// Integer epoch milliseconds for a Date, a number, or the default (now); an ISO 8601 string is sent as is.
function epochMillis (timestamp) {
  if (timestamp === undefined || timestamp === null) {
    return Date.now()
  }
  if (timestamp instanceof Date) {
    return timestamp.getTime()
  }
  return typeof timestamp === 'number' ? Math.trunc(timestamp) : timestamp
}

// The envelope's data. A 2xx whose body isn't the envelope still means the API accepted the batch (SPEC W6).
async function responseData (response) {
  try {
    const data = (await response.json())?.data
    return data && typeof data === 'object' ? data : {}
  } catch {
    return {}
  }
}

function backoff (attempt) {
  const base = Math.min(1000 * 2 ** attempt, MAX_BACKOFF_MS)
  return base / 2 + Math.random() * base / 2
}

function retryAfter (response) {
  const seconds = Number(response.headers.get('retry-after'))
  return response.headers.has('retry-after') && Number.isFinite(seconds) ? Math.min(seconds * 1000, 60000) : null
}

module.exports = { Vexo }
