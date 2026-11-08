// The Node.js, Deno, and Bun check (runtimes/check.mjs): imports the ES module with the default options, captures
// one event, flushes, and lets the process end on its own, which fails if the SDK's timer keeps it alive.
import { Vexo } from '../index.mjs'

const host = globalThis.Deno ? globalThis.Deno.args[0] : globalThis.process.argv[2]
const runtime = globalThis.Deno
  ? `Deno ${globalThis.Deno.version.deno}`
  : globalThis.Bun ? `Bun ${globalThis.Bun.version}` : `Node.js ${globalThis.process.version}`

const vexo = new Vexo('test-key', { host })
vexo.capture({ distinctId: 'runtime-check', event: 'runtime_check', properties: { runtime } })
await vexo.flush()
