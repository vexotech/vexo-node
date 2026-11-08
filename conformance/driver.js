'use strict'
// Conformance driver: reads a scenario on stdin, drives the SDK, and prints JSON lines.
// Protocol: vexo-sdk-conformance/README.md. Run: python3 run.py --driver "node conformance/driver.js"
const { writeSync } = require('node:fs')
const { Vexo } = require('..')

// Synchronous, so nothing is lost when the exit step ends the process.
const print = (line) => writeSync(1, JSON.stringify(line) + '\n')

async function main () {
  let input = ''
  for await (const chunk of process.stdin) input += chunk
  const { host, apiKey, options, steps } = JSON.parse(input)
  const vexo = new Vexo(apiKey, {
    host,
    flushAt: options.flushAt,
    flushInterval: options.flushIntervalMs,
    maxRetries: options.maxRetries,
    maxQueueSize: options.maxQueueSize,
    timeout: options.timeoutMs,
    shutdownTimeout: options.shutdownTimeoutMs,
    onError: (error) => print({ type: 'error', message: error.message, status: error.status ?? null })
  })
  for (const step of steps) {
    const start = performance.now()
    switch (step.op) {
      case 'capture':
        vexo.capture({
          distinctId: step.distinctId,
          event: step.event,
          properties: step.poison ? { ...step.properties, poison: 10n } : step.properties,
          timestamp: step.at ? new Date(step.at) : step.timestamp,
          messageId: step.messageId
        })
        break
      case 'identify':
        vexo.identify({ distinctId: step.distinctId, traits: step.traits })
        break
      case 'flush':
        await vexo.flush()
        break
      case 'shutdown':
        await vexo.shutdown()
        break
      case 'sleep':
        await new Promise((resolve) => setTimeout(resolve, step.ms))
        break
      case 'exit':
        process.exit(0)
    }
    print({ type: 'step', op: step.op, ms: performance.now() - start })
  }
}

main()
