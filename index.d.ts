export interface VexoOptions {
  /** API base URL. Default: https://api.vexo.co */
  host?: string
  /** Send a batch when this many messages are queued (1-500). Default: 100 */
  flushAt?: number
  /** Send whatever is queued every this many milliseconds. Default: 10000 */
  flushInterval?: number
  /** Retries for network errors, 429 and 5xx responses. Default: 3 */
  maxRetries?: number
  /** Messages kept in memory before new ones are dropped. Default: 10000 */
  maxQueueSize?: number
  /** Request timeout in milliseconds. Default: 10000 */
  timeout?: number
  /** Called with send failures and server-side drops. Default: console.error */
  onError?: (error: Error & { status?: number, batch?: object[], dropped?: { message: object, reason: string }[] }) => void
}

export interface CaptureMessage {
  distinctId: string
  event: string
  properties?: Record<string, unknown>
  /** Date, ISO 8601 string or epoch milliseconds. Default: now */
  timestamp?: Date | string | number
}

export interface IdentifyMessage {
  distinctId: string
  traits?: Record<string, unknown>
}

export class Vexo {
  constructor (apiKey: string, options?: VexoOptions)
  capture (message: CaptureMessage): void
  identify (message: IdentifyMessage): void
  flush (): Promise<void>
  shutdown (): Promise<void>
}
