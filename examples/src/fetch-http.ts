import type { HostPorts } from '@connector-hub/core'

/**
 * Minimal HTTP port on top of fetch. Good enough for examples; a production
 * adapter should also guard against private-network destinations.
 */
export function fetchHttp(): HostPorts['http'] {
  return {
    async send(request, { timeoutMs, maxBodyBytes }) {
      const init: RequestInit = { method: request.method, headers: request.headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) }
      if (request.body !== undefined) init.body = request.body
      const response = await fetch(request.url, init)
      const body = await response.text()
      if (Buffer.byteLength(body) > maxBodyBytes) throw new Error(`body larger than ${maxBodyBytes} bytes`)
      return { status: response.status, headers: Object.fromEntries(response.headers), body }
    },
  }
}

export const userAgent = '"connector-hub-examples/0.1 (https://github.com/akashks1998/connector-hub)"'
