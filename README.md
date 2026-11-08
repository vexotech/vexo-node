# vexo-node

Send events and identifies to [Vexo](https://vexo.co) from your Node.js backend: purchases, subscription changes, background jobs, anything your app's SDK can't see. Server events land in the same app as your mobile and web events, bill as events, and join the person who has the same distinct id.

- Zero runtime dependencies (Node.js 18 or later, global `fetch`).
- Batches messages, flushes on size and on an interval, and flushes on shutdown within a deadline.
- Retries network errors, `429`, and `5xx` responses (and the messages the API reports as `failed`) with exponential backoff, and honors `Retry-After`.
- Keeps each request under the API's 5 MB body limit.

## Install

```bash
npm install vexo-node
```

## Usage

```js
const { Vexo } = require('vexo-node')

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

## API

### `new Vexo(apiKey, options?)`

| Option | Default | Description |
| --- | --- | --- |
| `host` | `https://api.vexo.co` | API base URL. |
| `flushAt` | `100` | Send a batch when this many messages are queued (1 to 500). |
| `flushInterval` | `10000` | Send whatever is queued every this many milliseconds. |
| `maxRetries` | `3` | Retries for network errors, `429`, and `5xx` responses. |
| `maxQueueSize` | `10000` | Messages kept in memory; new messages are dropped once it's full. |
| `timeout` | `10000` | Request timeout in milliseconds. |
| `shutdownTimeout` | `10000` | How long `shutdown()` keeps sending, in milliseconds. |
| `onError` | `console.error` | Called with send failures and with messages the server dropped. |

### `vexo.capture({ distinctId, event, properties?, timestamp? })`

Queues an event. `timestamp` is a `Date`, an ISO 8601 string, or epoch milliseconds, and defaults to the time you call `capture()`.

### `vexo.identify({ distinctId, traits? })`

Queues an identify. Traits merge into the person's existing traits; a trait set to `null` is removed.

### `vexo.flush()`

Sends everything queued and resolves when the queue is empty.

### `vexo.shutdown()`

Stops the interval timer and sends everything queued, for up to `shutdownTimeout` milliseconds.

## Errors and dropped messages

The client never throws from `capture()` or `identify()`. Failures go to `onError`:

- A message that `JSON.stringify` can't serialize (for example, one with a `BigInt` property) or that is over 5 MB is dropped when you queue it; the rest of the queue is unaffected.
- A batch that still fails after the retries, or that the API rejects with a `4xx`, arrives as an error with `status` and `batch` (the messages it held). After that, the next batches get a single attempt until a request succeeds, so an unreachable API doesn't hold up your process.
- A message the API dropped (for example, properties over 64 KB) arrives as an error with `dropped`, a list of `{ message, reason }`. Messages the API reports as `failed` are retried, and reported the same way if they still fail.
- Messages still queued at the shutdown deadline arrive as one error with `batch`.

Every message carries a `messageId`, so a retried batch is stored once.

## Development

```bash
node --test
```

## License

MIT
