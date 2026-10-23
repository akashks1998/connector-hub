# Errors

The engine never retries on its own. Every failure during a run is a
`ConnectorError` whose `kind` tells your queue what to do.

```ts
import { ConnectorError } from '@connector-hub/core'

err.kind                  // 'retryable' | 'reauth' | 'permanent' | 'config'
err.details.status        // provider HTTP status, when there was one
err.details.retryAfterMs  // from Retry-After, when the provider sent it
err.cause                 // the underlying error, if any
```

| Kind | Raised for | What to do |
| --- | --- | --- |
| `retryable` | network errors, HTTP 408, 425, 429, 5xx | retry after `retryAfterMs`, or with backoff |
| `reauth` | HTTP 401/403 (after one token refresh for OAuth), token endpoint 400/401/403 | pause the binding, ask the user to reconnect |
| `permanent` | other 4xx; non-JSON or oversized bodies; a failing expression; a value that doesn't fit its field type; `records` not a list; empty or duplicate keys; repeated pages or cursors; failed `ack`; a request outside `hosts` | stop and alert; retrying won't help |
| `config` | unknown source or sink name; a binding missing required config or with the wrong type | fix the binding or the call |

`Retry-After` is read in both forms, seconds and HTTP date, and capped at
one day. Secret values are removed from error messages; when a transport
error had to be redacted, its original `cause` is dropped too.

A failed sink run reports `details.sent`, the number of batches acknowledged
before the failure. Those are saved, so a retry resumes after them.

Invalid plugins fail earlier, in `compilePlugin`, with a
`PluginValidationError` whose `problems` array lists every issue.
