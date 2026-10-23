import type { JsonValue } from '@connector-hub/spec'
import type { CompiledAuth, CompiledPlugin, CompiledRequest } from './compile.js'
import { ConnectorError } from './errors.js'
import type { Binding, HostPorts, HttpRequest, HttpResponse } from './ports.js'

export interface CallContext {
  plugin: CompiledPlugin
  binding: Binding
  ports: HostPorts<never>
  secrets: Record<string, string>
}

const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000
const encoder = new TextEncoder()

/** Builds a request from its declaration. Only the plugin's own hosts, and paths under them, are reachable. */
export function buildRequest(plugin: CompiledPlugin, request: CompiledRequest, vars: Record<string, unknown>): HttpRequest {
  const url = new URL(plugin.baseUrl + String(request.path.evaluate(vars)))
  if (!inScope(plugin, url)) {
    throw new ConnectorError('permanent', `refused request to ${url.origin}${url.pathname}: not under the plugin's hosts`)
  }
  for (const [name, expr] of request.query) {
    const value = expr.evaluate(vars)
    if (value !== null && value !== undefined) url.searchParams.set(name, String(value))
  }
  const headers: Record<string, string> = { accept: 'application/json' }
  for (const [name, expr] of request.headers) {
    const value = String(expr.evaluate(vars))
    if (/[\r\n\0]/.test(value)) throw new ConnectorError('permanent', `header ${name} contains a line break`)
    headers[name] = value
  }
  const out: HttpRequest = { method: request.method, url: url.toString(), headers }
  if (request.body) {
    out.body = JSON.stringify(request.body.evaluate(vars))
    headers['content-type'] ??= 'application/json'
  }
  return out
}

/** True when `url` is on one of the plugin's hosts and under that host's path. */
export function inScope(plugin: CompiledPlugin, url: URL): boolean {
  return plugin.scopes.some(
    (s) => s.origin === url.origin && (s.path === '' || url.pathname === s.path || url.pathname.startsWith(`${s.path}/`)),
  )
}

/** Sends with auth, classifies failures, and parses the JSON body. */
export async function call(ctx: CallContext, request: HttpRequest): Promise<{ status: number; headers: Record<string, string>; body: JsonValue }> {
  const response = await sendAuthorised(ctx, request, true)
  return { status: response.status, headers: response.headers, body: parseBody(response) }
}

async function sendAuthorised(ctx: CallContext, request: HttpRequest, mayRefresh: boolean): Promise<HttpResponse> {
  const authed = await authorise(ctx, request)
  const response = await send(ctx, authed)
  if ((response.status === 401 || response.status === 403) && ctx.plugin.auth.type === 'oauth2_client_credentials' && mayRefresh) {
    await ctx.ports.tokens.put(ctx.binding.id, null)
    return sendAuthorised(ctx, request, false)
  }
  classify(response, now(ctx))
  return response
}

async function send(ctx: CallContext, request: HttpRequest): Promise<HttpResponse> {
  const { limits } = ctx.plugin.declaration
  await ctx.ports.budget?.take(ctx.plugin.declaration.plugin)
  let response: HttpResponse
  try {
    response = await ctx.ports.http.send(request, { timeoutMs: limits.timeout_ms, maxBodyBytes: limits.max_body_bytes })
  } catch (cause) {
    const raw = `request failed: ${cause instanceof Error ? cause.message : String(cause)}`
    const message = redact(raw, ctx.secrets)
    // The host's error may quote the URL, which can carry a query-string key.
    throw new ConnectorError('retryable', message, message === raw ? { cause } : {})
  }
  if (byteLength(response.body) > limits.max_body_bytes) {
    throw new ConnectorError('permanent', `response larger than ${limits.max_body_bytes} bytes`)
  }
  return response
}

function classify(response: HttpResponse, at: Date): void {
  const { status } = response
  if (status >= 200 && status < 300) return
  if (status === 401 || status === 403) throw new ConnectorError('reauth', `provider rejected credentials (${status})`, { status })
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    const retryAfterMs = retryAfter(response.headers, at)
    throw new ConnectorError('retryable', `provider returned ${status}`, { status, ...(retryAfterMs !== undefined && { retryAfterMs }) })
  }
  throw new ConnectorError('permanent', `provider returned ${status}`, { status })
}

/** `Retry-After` as delay-seconds or an HTTP date, capped at one day. */
function retryAfter(headers: Record<string, string>, at: Date): number | undefined {
  const raw = Object.entries(headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]?.trim()
  if (!raw) return undefined
  let ms: number
  if (/^\d+$/.test(raw)) ms = Number(raw) * 1000
  else if (/[a-z]/i.test(raw) && !Number.isNaN(Date.parse(raw))) ms = Date.parse(raw) - at.getTime()
  else return undefined
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(0, ms))
}

/** Parses JSON. Integers too large for a JS number are kept exact, as strings. */
function parseBody(response: HttpResponse): JsonValue {
  if (response.body.trim() === '') return null
  try {
    return JSON.parse(response.body, (_key, value: unknown, context?: { source?: string }) =>
      typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value) && context?.source && /^-?\d+$/.test(context.source)
        ? context.source
        : value,
    ) as JsonValue
  } catch (cause) {
    throw new ConnectorError('permanent', 'provider returned a body that is not JSON', { cause })
  }
}

async function authorise(ctx: CallContext, request: HttpRequest): Promise<HttpRequest> {
  const auth = ctx.plugin.auth
  const vars = { secrets: ctx.secrets, config: ctx.binding.config }
  const headers = { ...request.headers }
  switch (auth.type) {
    case 'none':
      return request
    case 'api_key': {
      const value = String(auth.value.evaluate(vars))
      if (auth.in === 'header') return { ...request, headers: { ...headers, [auth.name.toLowerCase()]: value } }
      const url = new URL(request.url)
      url.searchParams.set(auth.name, value)
      return { ...request, url: url.toString() }
    }
    case 'bearer':
      return { ...request, headers: { ...headers, authorization: `Bearer ${String(auth.token.evaluate(vars))}` } }
    case 'basic': {
      const pair = `${String(auth.username.evaluate(vars))}:${String(auth.password.evaluate(vars))}`
      return { ...request, headers: { ...headers, authorization: `Basic ${base64(pair)}` } }
    }
    case 'oauth2_client_credentials':
      return { ...request, headers: { ...headers, authorization: `Bearer ${await accessToken(ctx, auth, vars)}` } }
  }
}

async function accessToken(
  ctx: CallContext,
  auth: Extract<CompiledAuth, { type: 'oauth2_client_credentials' }>,
  vars: Record<string, unknown>,
): Promise<string> {
  const at = now(ctx)
  const cached = await ctx.ports.tokens.get(ctx.binding.id)
  // Hosts that store the token as JSON hand back `expiresAt` as a string.
  const expiresAt = cached ? new Date(cached.expiresAt).getTime() : Number.NaN
  if (cached && expiresAt > at.getTime()) return cached.value

  const clientId = String(auth.clientId.evaluate(vars))
  const clientSecret = String(auth.clientSecret.evaluate(vars))
  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (auth.scope) form.set('scope', auth.scope)
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (auth.style === 'basic') headers.authorization = `Basic ${base64(`${clientId}:${clientSecret}`)}`
  else {
    form.set('client_id', clientId)
    form.set('client_secret', clientSecret)
  }
  const response = await send(ctx, { method: 'POST', url: auth.tokenUrl, headers, body: form.toString() })
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new ConnectorError('reauth', `token endpoint rejected the client credentials (${response.status})`, { status: response.status })
  }
  classify(response, at)
  const body = parseBody(response) as { access_token?: unknown; expires_in?: unknown } | null
  if (!body || typeof body.access_token !== 'string') throw new ConnectorError('permanent', 'token response has no access_token')
  const given = Number(body.expires_in)
  const ttlS = Number.isFinite(given) && given > 0 ? given : auth.defaultTtlS
  // Stop using a token a little before it expires: 60 s, or half its life if that is shorter.
  const useForS = ttlS - Math.min(60, ttlS / 2)
  const token = { value: body.access_token, expiresAt: new Date(at.getTime() + useForS * 1000) }
  await ctx.ports.tokens.put(ctx.binding.id, token)
  return token.value
}

function now(ctx: CallContext): Date {
  return ctx.ports.clock?.now() ?? new Date()
}

function byteLength(text: string): number {
  return encoder.encode(text).byteLength
}

function base64(text: string): string {
  let binary = ''
  for (const byte of encoder.encode(text)) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** Removes secret values, plain or URL-encoded, from a message. */
function redact(message: string, secrets: Record<string, string>): string {
  let out = message
  for (const value of Object.values(secrets)) {
    if (value.length < 4) continue
    for (const form of new Set([value, encodeURIComponent(value), new URLSearchParams({ v: value }).toString().slice(2)])) {
      out = out.split(form).join('***')
    }
  }
  return out
}
