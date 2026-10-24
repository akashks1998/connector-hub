import type { JsonValue } from '../spec/index.js'
import type { CompiledPlugin, CompiledWebhook } from './compile.js'
import { bindingFor, secretsFor } from './config.js'
import { ConnectorError } from './errors.js'
import { buildRequest, call, parseBody, type CallContext } from './http.js'
import type { HostPorts, TargetHttpRequest, WebhookRequest } from './ports.js'
import { buildTargetRequest, callTarget, targetLimits } from './target.js'
import { compareCursor } from './values.js'

export interface WebhookResult {
  /** The webhook that matched the path, or null. */
  webhook: string | null
  bindingId: string | null
  /**
   * `done`: the action ran. `ping`, `ignored` (`when` was false), `duplicate` and `stale` are
   * acknowledged without acting. `unknown_path`, `unknown_binding`, `unreadable` and `unverified`
   * are refused.
   */
  outcome: 'done' | 'ping' | 'ignored' | 'duplicate' | 'stale' | 'unknown_path' | 'unknown_binding' | 'unreadable' | 'unverified'
  /** The HTTP status the host should answer with. Errors thrown while acting are the host's to map. */
  status: 200 | 400 | 401 | 404
  /** Target requests sent, in order. */
  calls: TargetHttpRequest[]
  /** Sinks whose snapshots were forgotten: run them to send everything again. */
  resend: string[]
  /** A message to show as a problem with the binding. */
  issue: string | null
}

/**
 * Handles one incoming webhook request. Nothing runs before the request is verified against
 * its binding's secrets; dedupe and order marks are saved only after the action succeeds, so a
 * failed request is handled again when the provider retries it.
 */
export async function handleWebhook<Tx>(plugin: CompiledPlugin, request: WebhookRequest, ports: HostPorts<Tx>): Promise<WebhookResult> {
  const result = (webhook: CompiledWebhook | null, outcome: WebhookResult['outcome'], status: WebhookResult['status'], bindingId: string | null = null): WebhookResult => ({
    webhook: webhook?.name ?? null,
    bindingId,
    outcome,
    status,
    calls: [],
    resend: [],
    issue: null,
  })

  const webhook = plugin.webhooks.get(request.path) ?? null
  if (!webhook) return result(null, 'unknown_path', 404)
  if (!ports.webhooks) throw new ConnectorError('config', 'this plugin takes webhooks, but the host has no webhooks port')

  let body: JsonValue = null
  try {
    body = parseBody(request)
  } catch {
    // Not JSON: `raw_body` is still there for the plugin's checks.
  }
  const headers = Object.fromEntries(Object.entries(request.headers).map(([k, v]) => [k.toLowerCase(), v]))
  const req = { method: request.method.toUpperCase(), path: request.path, headers, query: request.query ?? {}, body, raw_body: request.body }

  // Expression failures here are the provider's malformed request, not a plugin bug.
  const attempt = <T>(fn: () => T): { ok: true; value: T } | { ok: false } => {
    try {
      return { ok: true, value: fn() }
    } catch (e) {
      if (e instanceof ConnectorError) return { ok: false }
      throw e
    }
  }

  if (webhook.ping) {
    const ping = attempt(() => webhook.ping!.evaluate({ request: req }))
    if (ping.ok && ping.value === true) return result(webhook, 'ping', 200)
  }

  const key = attempt(() => webhook.binding.evaluate({ request: req }))
  if (!key.ok || key.value === null || key.value === undefined || key.value === '') return result(webhook, 'unreadable', 400)
  const found = await ports.webhooks.binding(webhook.name, String(key.value))
  if (!found) return result(webhook, 'unknown_binding', 404)
  const binding = bindingFor(plugin, found)
  const secrets = await secretsFor(plugin, binding, ports.secrets)

  const verified = attempt(() => webhook.verify.evaluate({ request: req, config: binding.config, secrets }))
  if (!verified.ok || verified.value !== true) return result(webhook, 'unverified', 401, binding.id)

  const now = (ports.clock?.now() ?? new Date()).toISOString()
  const vars = { request: req, config: binding.config, now }
  if (webhook.when && webhook.when.evaluate(vars) !== true) return result(webhook, 'ignored', 200, binding.id)

  const marks = ports.webhooks
  let dedupe: string | null = null
  if (webhook.dedupeKey) {
    if (!marks.seen || !marks.remember) throw new ConnectorError('config', `webhooks.${webhook.name} has dedupe_key, but the host port has no seen/remember`)
    const value = attempt(() => webhook.dedupeKey!.evaluate({ request: req }))
    if (!value.ok || value.value === null || value.value === undefined || value.value === '') return result(webhook, 'unreadable', 400, binding.id)
    dedupe = String(value.value)
    if (await marks.seen(binding.id, webhook.name, dedupe)) return result(webhook, 'duplicate', 200, binding.id)
  }
  let order: JsonValue | null = null
  if (webhook.order) {
    if (!marks.getMark || !marks.saveMark) throw new ConnectorError('config', `webhooks.${webhook.name} has order, but the host port has no getMark/saveMark`)
    const value = attempt(() => webhook.order!.evaluate({ request: req }) as JsonValue)
    if (!value.ok || value.value === null || value.value === undefined) return result(webhook, 'unreadable', 400, binding.id)
    order = value.value
    const mark = await marks.getMark(binding.id, webhook.name)
    if (mark !== null && compareCursor(order, mark) <= 0) return result(webhook, 'stale', 200, binding.id)
  }

  const done = result(webhook, 'done', 200, binding.id)
  const send = async (request: TargetHttpRequest) => {
    try {
      await callTarget(ports as HostPorts<never>, request, targetLimits(plugin))
    } catch (e) {
      if (e instanceof ConnectorError) throw new ConnectorError(e.kind, `webhooks.${webhook.name}: ${e.message}`, { ...e.details, cause: e, sent: done.calls.length })
      throw e
    }
    done.calls.push(request)
  }

  if (webhook.call) {
    await send(buildTargetRequest(webhook.call, vars))
  } else if (webhook.reread) {
    const source = plugin.sources.get(webhook.reread.source)!
    const ctx: CallContext = { plugin, binding, ports: ports as HostPorts<never>, secrets }
    const response = await call(ctx, buildRequest(plugin, webhook.reread.request, vars))
    const records = webhook.reread.records
      ? webhook.reread.records.evaluate({ ...vars, response })
      : source.records.evaluate({ response, config: binding.config, cursor: null, page: {}, now })
    if (!Array.isArray(records)) throw new ConnectorError('permanent', `webhooks.${webhook.name}: records did not return a list`)
    const requests: TargetHttpRequest[] = []
    for (const record of records as JsonValue[]) {
      const recordVars = { record, config: binding.config, cursor: null, now }
      if (source.when && source.when.evaluate(recordVars) !== true) continue
      requests.push(buildTargetRequest(source.call!, recordVars))
    }
    for (const r of requests) await send(r)
  } else if (webhook.resend) {
    const forget = await Promise.all(webhook.resend.map(async (sink) => [sink, await ports.state.getRemote(binding.id, sink)] as const))
    await ports.transaction(async (tx) => {
      for (const [sink, rows] of forget) {
        if (rows.size > 0) await ports.saveRemote(binding.id, sink, new Map([...rows.keys()].map((k) => [k, null])), tx)
      }
    })
    done.resend = [...webhook.resend]
  } else if (webhook.issue) {
    done.issue = String(webhook.issue.evaluate(vars))
  }

  if (dedupe !== null) await marks.remember!(binding.id, webhook.name, dedupe)
  if (order !== null) await marks.saveMark!(binding.id, webhook.name, order)
  return done
}
