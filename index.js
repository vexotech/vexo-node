'use strict'

const { randomUUID } = require('node:crypto')
const { version } = require('./package.json')

const DEFAULT_HOST = 'https://api.vexo.co'
// The server rejects a batch of more than 500 messages.
const MAX_BATCH_SIZE = 500
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
    this.onError = options.onError || ((error) => console.error(`[vexo] ${error.message}`))

    this.queue = []
    this.closed = false
    this.pending = Promise.resolve()
    this.timer = setInterval(() => this.flush(), this.flushInterval)
    this.timer.unref()
    // A script that ends without calling shutdown() still sends what it queued.
    process.once('beforeExit', () => this.flush())
  }

  /** Queues an event. `timestamp` (Date, ISO 8601 string or epoch ms) defaults to now. */
  capture ({ distinctId, event, properties, timestamp } = {}) {
    if (!distinctId || !event) {
      this.onError(new Error('vexo: capture needs a distinctId and an event'))
      return
    }
    this.enqueue({
      type: 'capture',
      distinctId: String(distinctId),
      event: String(event),
      properties: properties || {},
      timestamp: timestamp instanceof Date ? timestamp.toISOString() : (timestamp ?? new Date().toISOString())
    })
  }

  /** Queues an identify: merges `traits` into the person with this distinct id. */
  identify ({ distinctId, traits } = {}) {
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

  /** Stops the interval timer and sends everything queued. Call it before your process exits. */
  async shutdown () {
    this.closed = true
    clearInterval(this.timer)
    await this.flush()
  }

  enqueue (message) {
    if (this.closed) {
      this.onError(new Error('vexo: the client is shut down; message dropped'))
      return
    }
    if (this.queue.length >= this.maxQueueSize) {
      this.onError(new Error('vexo: the queue is full; message dropped'))
      return
    }
    this.queue.push({ ...message, messageId: randomUUID() })
    if (this.queue.length >= this.flushAt) {
      this.flush()
    }
  }

  async drain () {
    while (this.queue.length > 0) {
      const batch = this.queue.splice(0, this.flushAt)
      try {
        const result = await this.send(batch)
        if (result && result.dropped && result.dropped.length > 0) {
          const error = new Error(`vexo: the server dropped ${result.dropped.length} message(s): ${result.dropped[0].reason}`)
          error.dropped = result.dropped.map(({ index, reason }) => ({ message: batch[index], reason }))
          this.onError(error)
        }
      } catch (error) {
        error.batch = batch
        this.onError(error)
      }
    }
  }

  // POST /v1/batch, retrying network errors, 429 and 5xx with exponential backoff (or the server's Retry-After).
  async send (batch) {
    for (let attempt = 0; ; attempt++) {
      let response
      try {
        response = await fetch(`${this.host}/v1/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Api-Key': this.apiKey, 'User-Agent': `vexo-node/${version}` },
          body: JSON.stringify({ batch }),
          signal: AbortSignal.timeout(this.timeout)
        })
      } catch (error) {
        if (attempt >= this.maxRetries) {
          throw error
        }
        await sleep(backoff(attempt))
        continue
      }
      if (response.ok) {
        const body = await response.json()
        return body.data
      }
      const retryable = response.status === 429 || response.status >= 500
      if (!retryable || attempt >= this.maxRetries) {
        const error = new Error(`vexo: batch rejected with HTTP ${response.status}: ${await response.text()}`)
        error.status = response.status
        throw error
      }
      await sleep(retryAfter(response) ?? backoff(attempt))
    }
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

function sleep (ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

module.exports = { Vexo }
