// The Cloudflare Workers check (runtimes/check.mjs runs it with `wrangler dev`). A Worker can't keep I/O or timers
// across requests, so it creates the client in the request, with no timer, and hands shutdown() to waitUntil.
import { Vexo } from '../index.mjs'

export default {
  async fetch (request, env, ctx) {
    const url = new URL(request.url)
    if (url.pathname !== '/capture') {
      return new Response('ready')
    }
    const vexo = new Vexo('test-key', { host: url.searchParams.get('host'), flushInterval: 0 })
    vexo.capture({ distinctId: 'runtime-check', event: 'runtime_check', properties: { runtime: navigator.userAgent } })
    ctx.waitUntil(vexo.shutdown())
    return new Response('ok')
  }
}
