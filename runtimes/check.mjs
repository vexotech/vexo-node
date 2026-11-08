// Checks the SDK on each runtime: starts a mock of the capture API, runs the runtime's check, and expects the one
// event it captures. Deno and Bun run from PATH when installed, otherwise in Docker; Workers and Vercel Edge run with
// npx (wrangler, edge-runtime), no account needed.
//
//   node runtimes/check.mjs node deno bun workerd workerd-nodejs-compat vercel-edge
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const onPath = (bin) => spawnSync(bin, ['--version']).status === 0
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const runtimes = process.argv.slice(2)
const dockerized = (runtime) => ['deno', 'bun'].includes(runtime) && !onPath(runtime)

// The mock: records each batch and accepts every message.
const batches = []
const mock = createServer((req, res) => {
  let body = ''
  req.on('data', (chunk) => { body += chunk })
  req.on('end', () => {
    const { batch } = JSON.parse(body)
    batches.push({ headers: req.headers, batch })
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ success: true, code: 200, message: null, data: { accepted: batch.length, dropped: [], failed: [] } }))
  })
})
// A Docker container reaches the mock through host.docker.internal, so it then listens on every interface.
await new Promise((resolve) => mock.listen(0, runtimes.some(dockerized) ? '0.0.0.0' : '127.0.0.1', resolve))
const port = mock.address().port
const host = `http://127.0.0.1:${port}`

// [command, args, label prefix, server port or undefined] for each runtime.
function plan (runtime) {
  const docker = (image, ...args) => ['docker', ['run', '--rm', '--init', '-v', `${root}:/src:ro`, '-w', '/src', image,
    ...args, `http://host.docker.internal:${port}`]]
  const serverPort = port + 1 + runtimes.indexOf(runtime)
  switch (runtime) {
    case 'node':
      return [process.execPath, ['runtimes/script.mjs', host], 'Node.js']
    case 'deno':
      return [...(dockerized('deno') ? docker('denoland/deno', 'run', '--allow-net', 'runtimes/script.mjs')
        : ['deno', ['run', '--allow-net', 'runtimes/script.mjs', host]]), 'Deno']
    case 'bun':
      return [...(dockerized('bun') ? docker('oven/bun', 'bun', 'runtimes/script.mjs') : ['bun', ['runtimes/script.mjs', host]]),
        'Bun']
    case 'workerd':
    case 'workerd-nodejs-compat':
      return ['npx', ['--yes', 'wrangler@4', 'dev', join(root, 'runtimes/worker.mjs'), '--ip', '127.0.0.1',
        '--port', String(serverPort), '--compatibility-date', '2026-06-01',
        ...(runtime === 'workerd' ? [] : ['--compatibility-flags', 'nodejs_compat'])], 'Cloudflare-Workers', serverPort]
    case 'vercel-edge': {
      const script = join(mkdtempSync(join(tmpdir(), 'vexo-edge-')), 'edge.js')
      writeFileSync(script, `const module = { exports: {} }\n${readFileSync(join(root, 'index.js'), 'utf8')}\n` +
        `const VEXO_HOST = ${JSON.stringify(host)}\n` +
        readFileSync(join(root, 'runtimes/edge.js'), 'utf8'))
      return ['npx', ['--yes', 'edge-runtime@4', '--listen', script, '--port', String(serverPort)], 'EdgeRuntime', serverPort]
    }
    default:
      throw new Error(`unknown runtime ${runtime}`)
  }
}

async function check (runtime) {
  batches.length = 0
  const [command, args, label, serverPort] = plan(runtime)
  // A Workers or edge-runtime server (and its children) runs in its own process group, so it can be stopped.
  const child = spawn(command, args, { cwd: root, detached: serverPort !== undefined, env: { ...process.env, WRANGLER_SEND_METRICS: 'false' } })
  let output = ''
  child.stdout.on('data', (chunk) => { output += chunk })
  child.stderr.on('data', (chunk) => { output += chunk })
  const exited = new Promise((resolve) => child.on('exit', resolve))
  try {
    if (serverPort !== undefined) {
      await until(180000, async () => {
        assert(child.exitCode === null, `the runtime exited with code ${child.exitCode} before it served a request`)
        return (await fetch(`http://127.0.0.1:${serverPort}/`).catch(() => null))?.ok
      }, 'start')
      await fetch(`http://127.0.0.1:${serverPort}/capture?host=${encodeURIComponent(host)}`)
    } else if (await Promise.race([exited.then(() => true), sleep(60000)]) !== true) {
      throw new Error('the process didn\'t exit on its own within 60 s (does a timer keep it alive?)')
    }
    await until(30000, () => batches.length > 0, 'send the event')
    const [{ headers, batch: [message] }] = batches
    assert(headers['user-agent'] === `vexo-node/${version}`, `User-Agent ${headers['user-agent']}`)
    assert(message.event === 'runtime_check' && Number.isInteger(message.timestamp) && /^[0-9a-f-]{36}$/.test(message.messageId),
      `message ${JSON.stringify(message)}`)
    assert(message.properties.runtime.startsWith(label), `expected the event from ${label}, got ${message.properties.runtime}`)
    console.log(`PASS ${runtime.padEnd(22)} ${message.properties.runtime}`)
    return true
  } catch (error) {
    console.log(`FAIL ${runtime.padEnd(22)} ${error.message}\n${output.slice(-3000)}`)
    return false
  } finally {
    if (serverPort !== undefined) {
      try { process.kill(-child.pid) } catch {}
    }
  }
}

async function until (ms, condition, what) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    if (await condition()) return
  }
  throw new Error(`timed out waiting for the runtime to ${what}`)
}

function assert (condition, message) {
  if (!condition) throw new Error(message)
}

let failed = 0
for (const runtime of runtimes) {
  if (!await check(runtime)) failed++
}
mock.close()
process.exit(failed ? 1 : 0)
