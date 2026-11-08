# vexo-node

Send events and identifies to [Vexo](https://vexo.co) from your JavaScript backend: purchases, subscription changes, background jobs, anything your app's SDK can't see. Server events land in the same app as your mobile and web events, bill as events, and join the person who has the same distinct id.

- Zero runtime dependencies. Runs on Node.js 18 or later, Deno, Bun, Cloudflare Workers, Vercel Edge, and Supabase Edge Functions: an ES module that uses only Web APIs, with a CommonJS build for `require()`.
- Batches messages, flushes on size and on an interval, and flushes on shutdown within a deadline.
- Retries network errors, `429`, and `5xx` responses (and the messages the API reports as `failed`) with exponential backoff, and honors `Retry-After`.
- Keeps each request under the API's 5 MB body limit.

## Install

```bash
npm install vexo-node
```

## Usage

```js
import { Vexo } from 'vexo-node' // or: const { Vexo } = require('vexo-node')

const vexo = new Vexo(process.env.VEXO_API_KEY)

// Attach traits to the person. Use the same id you pass to identifyDevice() in the app SDK.
vexo.identify({ distinctId: 'user@example.com', traits: { plan: 'pro', company: 'Acme' } })

// Record an event.
vexo.capture({
  distinctId: 'user@example.com',
  event: 'purchase_completed',
  properties: { amount: 49.9, currency: 'USD' }
})

// Before your process exits, send everything still queued.
process.on('SIGTERM', async () => {
  await vexo.shutdown()
  process.exit(0)
})
```

`capture()` and `identify()` only queue the message, so they never block a request. A script that ends without calling `shutdown()` still shuts the client down when its event loop empties, but a server that exits on a signal must call `await vexo.shutdown()` first. `shutdown()` gives up after `shutdownTimeout` milliseconds and reports what was still queued to `onError`.

Copy your app's API key from the app's [settings](https://docs.vexo.co/settings/app-settings/app-general-information) in the Vexo dashboard. It's the same key your app SDK uses, so it isn't a secret; see [Security](https://docs.vexo.co/server-side/capture#security).

## Serverless and edge runtimes

A serverless function or an edge isolate has no long-lived process: it can be frozen or stopped as soon as it returns a response, so the interval timer and the exit hook can't be relied on. Create the client with `flushInterval: 0`, which turns the timer off, and hand `vexo.flush()` to the platform's `waitUntil()`, which keeps the function alive until the events are sent without delaying the response.

### Supabase Edge Functions (Deno)

```ts
import { Vexo } from 'npm:vexo-node'

const vexo = new Vexo(Deno.env.get('VEXO_API_KEY')!, { flushInterval: 0 })

Deno.serve(async (req) => {
  const { userId } = await req.json()
  vexo.capture({ distinctId: userId, event: 'report_exported' })
  EdgeRuntime.waitUntil(vexo.flush())
  return new Response('ok')
})
```

### Cloudflare Workers

A Worker can't reuse a request's I/O in another request, so create the client inside `fetch()`. Hand `shutdown()` to `waitUntil()`: it sends the queue like `flush()` and also releases the client.

```js
import { Vexo } from 'vexo-node'

export default {
  async fetch (request, env, ctx) {
    const vexo = new Vexo(env.VEXO_API_KEY, { flushInterval: 0 })
    vexo.capture({ distinctId: 'user@example.com', event: 'report_exported' })
    ctx.waitUntil(vexo.shutdown())
    return new Response('ok')
  }
}
```

The `nodejs_compat` compatibility flag isn't needed.

### Vercel Functions (Edge or Node.js runtime)

Use `waitUntil()` from the [`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package) package, which you install in your app:

```js
import { waitUntil } from '@vercel/functions'
import { Vexo } from 'vexo-node'

const vexo = new Vexo(process.env.VEXO_API_KEY, { flushInterval: 0 })

export async function POST (request) {
  const { userId } = await request.json()
  vexo.capture({ distinctId: userId, event: 'report_exported' })
  waitUntil(vexo.flush())
  return new Response('ok')
}
```

### AWS Lambda and other functions without `waitUntil()`

Await the flush before you return, and keep `maxRetries` and `timeout` small enough to fit the function's timeout:

```js
const { Vexo } = require('vexo-node')

const vexo = new Vexo(process.env.VEXO_API_KEY, { flushInterval: 0, maxRetries: 1, timeout: 3000 })

exports.handler = async (event) => {
  vexo.capture({ distinctId: event.userId, event: 'order_placed' })
  await vexo.flush()
  return { statusCode: 200 }
}
```

On a long-lived Deno or Bun server, use the client as you would on Node.js: the default options work, and Bun runs the exit hook like Node.js does.

## API

### `new Vexo(apiKey, options?)`

| Option | Default | Description |
| --- | --- | --- |
| `host` | `https://api.vexo.co` | API base URL. |
| `flushAt` | `100` | Send a batch when this many messages are queued (1 to 500). |
| `flushInterval` | `10000` | Send whatever is queued every this many milliseconds. `0` turns the timer off, so messages go out only on `flushAt`, `flush()`, and `shutdown()`. |
| `maxRetries` | `3` | Retries for network errors, `429`, and `5xx` responses. |
| `maxQueueSize` | `10000` | Messages kept in memory; new messages are dropped once it's full. |
| `timeout` | `10000` | Request timeout in milliseconds. |
| `shutdownTimeout` | `10000` | How long `shutdown()` keeps sending, in milliseconds. |
| `onError` | `console.error` | Called with send failures and with messages the server dropped. |

### `vexo.capture({ distinctId, event, properties?, timestamp?, messageId? })`

Queues an event. `timestamp` is a `Date`, an ISO 8601 string with an offset, or epoch milliseconds, and defaults to the time you call `capture()`. A `Date` or a number is sent as integer epoch milliseconds. `messageId` defaults to a random UUID; pass your own, such as an order ID, so that Vexo stores the event once even when your code sends it twice.

### `vexo.identify({ distinctId, traits? })`

Queues an identify. Traits merge into the person's existing traits; a trait set to `null` is removed.

### `vexo.flush()`

Sends everything queued and resolves when the queue is empty.

### `vexo.shutdown()`

Stops the interval timer and sends everything queued, for up to `shutdownTimeout` milliseconds.

## Errors and dropped messages

The client never throws from `capture()` or `identify()`. Failures go to `onError`:

- A `Date` in properties or traits is sent as an ISO 8601 string in UTC, such as `2026-11-07T12:00:00.000Z`, the form every Vexo SDK uses. A string with a lone UTF-16 surrogate is sent with the surrogate escaped, not dropped.
- A message that `JSON.stringify` can't serialize (for example, one with a `BigInt` property), one with a `NaN` or `Infinity` value (which `JSON.stringify` would turn into `null`), or one over 5 MB is dropped when you queue it; the rest of the queue is unaffected.
- A batch that still fails after the retries, or that the API rejects with a `4xx`, arrives as an error with `status` and `batch` (the messages it held). After that, the next batches get a single attempt until a request succeeds, so an unreachable API doesn't hold up your process.
- A message the API dropped (for example, properties over 64 KB) arrives as an error with `dropped`, a list of `{ message, reason }`. Messages the API reports as `failed` are retried, and reported the same way if they still fail.
- Messages still queued at the shutdown deadline arrive as one error with `batch`.

Every message carries a `messageId`, so a retried batch is stored once.

## Development

```bash
npm test                     # builds index.js from index.mjs, then runs the unit tests
node runtimes/check.mjs node deno bun workerd workerd-nodejs-compat vercel-edge
```

Edit `index.mjs`: `index.js` is its CommonJS build, which `npm test` and `npm pack` regenerate; commit both. `runtimes/check.mjs` starts a mock of the capture API, runs the SDK on each runtime you name, and expects the event it captures. It runs Deno and Bun from your `PATH`, or in Docker (`denoland/deno`, `oven/bun`) when they aren't installed, and Cloudflare Workers and Vercel Edge with `npx wrangler` and `npx edge-runtime` (no account needed).

`conformance/driver.mjs` runs the [vexo-sdk-conformance](https://github.com/vexotech/vexo-sdk-conformance) scenarios on Node.js, Bun, or Deno:

```bash
python3 ../vexo-sdk-conformance/run.py --driver "node conformance/driver.mjs"
```

## License

MIT
