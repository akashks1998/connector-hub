/**
 * What the host should do next. The engine never retries on its own; it tells
 * the host's queue whether and when to try again.
 */
export type ErrorKind =
  /** Try again later, after `retryAfterMs` when known. */
  | 'retryable'
  /** Credentials were rejected. Pause the binding and ask the user to reconnect. */
  | 'reauth'
  /** Retrying won't help: bad request, unexpected response, failed ack. */
  | 'permanent'
  /** The plugin or binding is invalid. Fix the declaration or config. */
  | 'config'

export class ConnectorError extends Error {
  constructor(
    readonly kind: ErrorKind,
    message: string,
    readonly details: {
      retryAfterMs?: number
      status?: number
      /** For a failed sink run: batches acknowledged before the failure. For a `call` source: calls that succeeded. */
      sent?: number
      cause?: unknown
    } = {},
  ) {
    super(message, { cause: details.cause })
    this.name = 'ConnectorError'
  }
}

export class PluginValidationError extends Error {
  constructor(readonly problems: string[]) {
    super(`invalid plugin:\n${problems.map((p) => `  - ${p}`).join('\n')}`)
    this.name = 'PluginValidationError'
  }
}
