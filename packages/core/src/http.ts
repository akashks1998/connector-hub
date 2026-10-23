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

/** Builds a request from its declaration. Only the plugin's own hosts are reachable. */
export function buildRequest(plugin: CompiledPlugin, request: CompiledRequest, vars: Record<string, unknown>): HttpRequest {
  const url = new URL(plugin.baseUrl + String(request.path.evaluate(vars)))
  if (!plugin.origins.has(url.origin)) {
    throw new ConnectorError('permanent', `refused request to ${url.origin}: not in the plugin's hosts`)
  }
  for (const [name, expr] of request.query) {
    const value = expr.evaluate(vars)
    if (value !== null && value !== undefined) url.searchParams.set(name, String(value))
  }
  const headers: Record<string, string> = { accept: 'application/json' }
  for (const [name, expr] of request.headers) headers[name.toLowerCase()] = String(expr.evaluate(vars))
  const out: HttpRequest = { method: request.method, url: url.toString(), headers }
  if (request.body) {
    out.body = JSON.stringify(request.body.evaluate(vars))
    headers['content-type'] = 'application/json'
  }
  return out
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
  classify(response)
  return response
}

async function send(ctx: CallContext, request: HttpRequest): Promise<HttpResponse> {
  const { limits } = ctx.plugin.declaration
  await ctx.ports.budget?.take(ctx.plugin.declaration.plugin)
  let response: HttpResponse
  try {
    response = await ctx.ports.http.send(request, { timeoutMs: limits.timeout_ms, maxBodyBytes: limits.max_body_bytes })
  } catch (cause) {
    throw new ConnectorError('retryable', `request failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
  }
  if (Buffer.byteLength(response.body) > limits.max_body_bytes) {
    throw new ConnectorError('permanent', `response larger than ${limits.max_body_bytes} bytes`)
  }
  return response
}

function classify(response: HttpResponse): void {
  const { status } = response
  if (status >= 200 && status < 300) return
  if (status === 401 || status === 403) throw new ConnectorError('reauth', `provider rejected credentials (${status})`, { status })
  if (status === 408 || status === 425 || status === 429 || status >= 500) {
    const retryAfterMs = retryAfter(response.headers)
    throw new ConnectorError('retryable', `provider returned ${status}`, { status, ...(retryAfterMs !== undefined && { retryAfterMs }) })
  }
  throw new ConnectorError('permanent', `provider returned ${status}`, { status })
}

function retryAfter(headers: Record<string, string>): number | undefined {
  const raw = Object.entries(headers).find(([k]) => k.toLowerCase() === 'retry-after')?.[1]
  if (!raw) return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(raw)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function parseBody(response: HttpResponse): JsonValue {
  if (response.body.trim() === '') return null
  try {
    return JSON.parse(response.body) as JsonValue
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
      return { ...request, headers: { ...headers, authorization: `Basic ${Buffer.from(pair).toString('base64')}` } }
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
  const now = ctx.ports.clock?.now() ?? new Date()
  const cached = await ctx.ports.tokens.get(ctx.binding.id)
  if (cached && cached.expiresAt.getTime() - 60_000 > now.getTime()) return cached.value

  const clientId = String(auth.clientId.evaluate(vars))
  const clientSecret = String(auth.clientSecret.evaluate(vars))
  const form = new URLSearchParams({ grant_type: 'client_credentials' })
  if (auth.scope) form.set('scope', auth.scope)
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }
  if (auth.style === 'basic') headers.authorization = `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`
  else {
    form.set('client_id', clientId)
    form.set('client_secret', clientSecret)
  }
  const url = new URL(auth.tokenUrl, `${ctx.plugin.baseUrl}/`).toString()
  const response = await send(ctx, { method: 'POST', url, headers, body: form.toString() })
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    throw new ConnectorError('reauth', `token endpoint rejected the client credentials (${response.status})`, { status: response.status })
  }
  classify(response)
  const body = parseBody(response) as { access_token?: unknown; expires_in?: unknown } | null
  if (!body || typeof body.access_token !== 'string') throw new ConnectorError('permanent', 'token response has no access_token')
  const ttl = typeof body.expires_in === 'number' ? body.expires_in : auth.defaultTtlS
  const token = { value: body.access_token, expiresAt: new Date(now.getTime() + ttl * 1000) }
  await ctx.ports.tokens.put(ctx.binding.id, token)
  return token.value
}
