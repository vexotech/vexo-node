// The Vercel Edge check, for the edge-runtime emulator (runtimes/check.mjs). edge-runtime runs a script, not a module,
// so check.mjs puts the SDK's CommonJS build (which defines Vexo) and VEXO_HOST before this code. One client for the
// isolate, with no timer, and waitUntil(flush()) in each request.
/* global Vexo, VEXO_HOST, EdgeRuntime */
const vexo = new Vexo('test-key', { host: VEXO_HOST, flushInterval: 0 })

addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname !== '/capture') {
    return event.respondWith(new Response('ready'))
  }
  vexo.capture({ distinctId: 'runtime-check', event: 'runtime_check', properties: { runtime: `EdgeRuntime ${EdgeRuntime}` } })
  event.waitUntil(vexo.flush())
  event.respondWith(new Response('ok'))
})
