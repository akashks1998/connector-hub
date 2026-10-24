import type { JsonValue } from '../spec/index.js'
import type { CompiledTargetRequest } from './compile.js'
import { ConnectorError } from './errors.js'
import { parseBody, retryAfter } from './http.js'
import type { HostPorts, TargetHttpRequest } from './ports.js'

/** Renders a target request. The path stays relative: the host resolves it under its API root. */
export function buildTargetRequest(request: CompiledTargetRequest, vars: Record<string, unknown>): TargetHttpRequest {
  const path = String(request.path.evaluate(vars))
  const query = new URLSearchParams()
  for (const [name, expr] of request.query) {
    const value = expr.evaluate(vars)
    if (value !== null && value !== undefined) query.set(name, String(value))
  }
  const text = query.toString()
  const out: TargetHttpRequest = { method: request.method, path: text ? `${path}?${text}` : path }
  if (request.body) out.body = JSON.stringify(request.body.evaluate(vars))
  return out
}

/**
 * Sends to the host's own API. A rejected install key is a `config` problem, not a provider
 * reconnect. The host's error message is kept: it is the host's own text, and says what to fix.
 */
export async function callTarget(ports: HostPorts<never>, request: TargetHttpRequest): Promise<{ status: number; body: JsonValue }> {
  if (!ports.target) throw new ConnectorError('config', 'this plugin calls the target API, but the host has no target port')
  let response
  try {
    response = await ports.target.send(request)
  } catch (cause) {
    throw new ConnectorError('retryable', `target request failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
  const { status } = response
  if (status < 200 || status >= 300) {
    const what = `target ${request.method} ${request.path.split('?')[0]} returned ${status}${detail(response.body)}`
    if (status === 401 || status === 403) throw new ConnectorError('config', what, { status })
    if (status === 408 || status === 425 || status === 429 || status >= 500) {
      const retryAfterMs = retryAfter(response.headers, ports.clock?.now() ?? new Date())
      throw new ConnectorError('retryable', what, { status, ...(retryAfterMs !== undefined && { retryAfterMs }) })
    }
    throw new ConnectorError('permanent', what, { status })
  }
  return { status, body: parseBody(response) }
}

function detail(body: string): string {
  const text = body.trim()
  if (!text) return ''
  try {
    const parsed = JSON.parse(text) as { message?: unknown; reason?: unknown }
    const message = Array.isArray(parsed.message) ? parsed.message.join('; ') : parsed.message
    if (typeof message === 'string') return `: ${message.slice(0, 200)}${typeof parsed.reason === 'string' ? ` (${parsed.reason})` : ''}`
  } catch {
    // Not JSON: show the start of the text.
  }
  return `: ${text.slice(0, 200)}`
}
