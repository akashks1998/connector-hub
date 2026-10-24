import { CelEnvironment, ExpressionError, type CelType, type CompiledExpression } from '../cel/index.js'
import {
  DomainPack,
  ENGINE_CONTRACT,
  ENGINE_CONTRACTS,
  Plugin,
  satisfies,
  type Auth,
  type FieldDef,
  type Paginate,
  type PluginInput,
  type Request,
  type TargetRequest,
} from '../spec/index.js'
import { z } from 'zod'
import { ConnectorError, PluginValidationError } from './errors.js'

export interface CompiledRequest {
  method: Request['method']
  path: CompiledExpression
  query: Array<[string, CompiledExpression]>
  headers: Array<[string, CompiledExpression]>
  body?: CompiledExpression
}

export interface CompiledEmit {
  operation: string
  entity: string
  kind: 'upsert' | 'patch' | 'delete'
  keyFields: string[]
  /** Domain definition of each emitted field, for checking values. */
  types: Record<string, FieldDef>
  when?: CompiledExpression
  fields: Array<[string, CompiledExpression]>
}

/** A request to the target API. The path template renders relative to the target root. */
export interface CompiledTargetRequest {
  method: TargetRequest['method']
  path: CompiledExpression
  query: Array<[string, CompiledExpression]>
  body?: CompiledExpression
}

export interface CompiledSource {
  name: string
  request: CompiledRequest
  paginate: Paginate
  next?: CompiledExpression
  records: CompiledExpression
  when?: CompiledExpression
  emits: CompiledEmit[]
  call?: CompiledTargetRequest
  cursor?: CompiledExpression
}

export interface CompiledSinkRead {
  request: CompiledTargetRequest
  records: CompiledExpression
  paginate: Paginate
  next?: CompiledExpression
}

interface CompiledSinkBase {
  name: string
  where?: CompiledExpression
  skip?: CompiledExpression
  on: string[]
  /** Sinks that run before this one when both run. */
  after: string[]
  onDelete: 'ignore' | 'send'
  batchSize: number
  by?: CompiledExpression
  request: CompiledRequest
  ack?: CompiledExpression
}

/** Rows come from the host's `read` port, typed by a domain entity. */
export interface CompiledDomainSink extends CompiledSinkBase {
  mode: 'domain'
  entity: string
  keyFields: string[]
  /** Exactly the fields the sink may see: its declared fields plus the entity key. */
  visibleFields: string[]
  declaredFields: string[]
}

/** Rows come from the target API. */
export interface CompiledTargetSink extends CompiledSinkBase {
  mode: 'target'
  read: CompiledSinkRead
  key: CompiledExpression
  /** Fields compared with and saved as the last write; null for the whole row. */
  fields: string[] | null
}

export type CompiledSink = CompiledDomainSink | CompiledTargetSink

export type CompiledAuth =
  | { type: 'none' }
  | { type: 'api_key'; in: 'header' | 'query'; name: string; value: CompiledExpression }
  | { type: 'bearer'; token: CompiledExpression }
  | { type: 'basic'; username: CompiledExpression; password: CompiledExpression }
  | {
      type: 'oauth2_client_credentials'
      /** Absolute, resolved against the first host. */
      tokenUrl: string
      clientId: CompiledExpression
      clientSecret: CompiledExpression
      scope?: string
      style: 'form' | 'basic'
      defaultTtlS: number
      notBeforeMs: number
    }

export interface CompiledPlugin {
  readonly declaration: Plugin
  /** Null for a plugin that only talks to the target API. */
  readonly domain: DomainPack | null
  /** Origin and path prefix of each host. Requests must fall under one of them. */
  readonly scopes: ReadonlyArray<{ origin: string; path: string }>
  readonly baseUrl: string
  readonly auth: CompiledAuth
  /** Headers on every provider request, over `secrets` and `config`. */
  readonly headers: ReadonlyArray<[string, CompiledExpression]>
  readonly sources: ReadonlyMap<string, CompiledSource>
  readonly sinks: ReadonlyMap<string, CompiledSink>
  /** By path. */
  readonly webhooks: ReadonlyMap<string, CompiledWebhook>
}

export interface CompiledWebhook {
  name: string
  path: string
  ping?: CompiledExpression
  binding: CompiledExpression
  verify: CompiledExpression
  when?: CompiledExpression
  dedupeKey?: CompiledExpression
  order?: CompiledExpression
  call?: CompiledTargetRequest
  reread?: { source: string; request: CompiledRequest; records?: CompiledExpression }
  resend?: string[]
  issue?: CompiledExpression
}

/** `now` is the run's start time as an ISO timestamp string, so expressions stay deterministic. */
const envs = {
  auth: { secrets: 'map', config: 'map' },
  request: { config: 'map', cursor: 'dyn', page: 'map', now: 'string' },
  response: { response: 'map', config: 'map', cursor: 'dyn', page: 'map', now: 'string' },
  record: { record: 'map', config: 'map', cursor: 'dyn', now: 'string' },
  cursor: { record: 'map' },
  row: { row: 'map', config: 'map', now: 'string' },
  batch: { batch: 'map', config: 'map', now: 'string' },
  ack: { response: 'map', batch: 'map', config: 'map', now: 'string' },
  webhookKey: { request: 'map' },
  webhookVerify: { request: 'map', config: 'map', secrets: 'map' },
  webhook: { request: 'map', config: 'map', now: 'string' },
  webhookResponse: { response: 'map', request: 'map', config: 'map', now: 'string' },
} satisfies Record<string, Record<string, CelType>>

/** Headers the transport or an auth preset controls. */
const RESERVED_HEADERS = new Set([
  'host', 'content-length', 'transfer-encoding', 'connection', 'keep-alive', 'upgrade', 'te', 'trailer',
  'proxy-authorization', 'proxy-connection', 'authorization',
])
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9a-z-]+$/

/** Largest value an expression may produce, in characters plus elements, relative to `max_body_bytes`. */
const RESULT_SIZE_FACTOR = 2

/**
 * Validates a plugin declaration against its domain pack and compiles every
 * expression. All problems are reported together.
 */
export function compilePlugin(input: PluginInput | unknown, domainInput?: DomainPack | unknown): CompiledPlugin {
  let domain: DomainPack | null = null
  if (domainInput !== undefined) {
    const domainResult = DomainPack.safeParse(domainInput)
    if (!domainResult.success) throw new PluginValidationError([`domain pack: ${z.prettifyError(domainResult.error)}`])
    domain = domainResult.data
  }

  const parsed = Plugin.safeParse(input)
  if (!parsed.success) throw new PluginValidationError(z.prettifyError(parsed.error).split('\n').filter(Boolean))
  const plugin = parsed.data

  const problems: string[] = []
  const cel = Object.fromEntries(Object.entries(envs).map(([k, v]) => [k, new CelEnvironment({ variables: v })])) as Record<
    keyof typeof envs,
    CelEnvironment
  >

  if (!ENGINE_CONTRACTS.some((c) => satisfies(c, plugin.engine))) {
    problems.push(`engine: plugin needs ${plugin.engine}, this engine implements ${ENGINE_CONTRACT}`)
  }
  if (plugin.domain) {
    if (!domain) problems.push(`domain: plugin needs the ${plugin.domain.name} domain pack`)
    else if (plugin.domain.name !== domain.domain || !satisfies(domain.version, plugin.domain.version)) {
      problems.push(`domain: plugin needs ${plugin.domain.name} ${plugin.domain.version}, got ${domain.domain} ${domain.version}`)
    }
  }
  // Only a plugin that declares a domain may use it.
  const pack = plugin.domain ? domain : null
  if (!pack) {
    for (const [name, s] of Object.entries(plugin.sources)) if (s.emit.length > 0) problems.push(`sources.${name}.emit: needs a domain; use call`)
    for (const [name, s] of Object.entries(plugin.sinks)) if (s.input) problems.push(`sinks.${name}.input: needs a domain; use read`)
    if (Object.keys(plugin.owns).length > 0) problems.push('owns: needs a domain')
  }

  const secretKeys = new Set(Object.entries(plugin.config).filter(([, f]) => f.secret).map(([k]) => k))
  const configKeys = new Set(Object.entries(plugin.config).filter(([, f]) => !f.secret).map(([k]) => k))

  const compile = (env: keyof typeof envs, source: string, where: string, template = false): CompiledExpression => {
    try {
      const expr = template ? cel[env].compileTemplate(source) : cel[env].compile(source)
      for (const ref of expr.refs) {
        const [root, key] = ref.split('.')
        if ((root === 'config' || root === 'secrets') && !key) {
          problems.push(`${where}: read ${root} fields by name, e.g. ${root}.account_id`)
        }
        if (root === 'config' && key && !configKeys.has(key)) {
          problems.push(`${where}: config.${key} is not a declared non-secret config field`)
        }
        if (root === 'secrets' && key && !secretKeys.has(key)) {
          problems.push(`${where}: secrets.${key} is not a declared secret config field`)
        }
      }
      return guard(expr, where, plugin.limits.max_body_bytes * RESULT_SIZE_FACTOR)
    } catch (e) {
      problems.push(`${where}: ${e instanceof ExpressionError ? e.message : String(e)} in \`${source}\``)
      return { source, refs: new Set(), evaluate: () => undefined }
    }
  }

  const compileHeaders = (headers: Record<string, string>, env: keyof typeof envs, where: string): Array<[string, CompiledExpression]> => {
    for (const name of Object.keys(headers)) {
      const lower = name.toLowerCase()
      if (!HEADER_NAME.test(lower)) problems.push(`${where}: ${JSON.stringify(name)} is not a valid header name`)
      else if (RESERVED_HEADERS.has(lower)) problems.push(`${where}: ${lower} is set by the engine or host`)
    }
    return Object.entries(headers).map(([k, v]) => [k.toLowerCase(), compile(env, v, `${where}.${k}`)])
  }

  const compileRequest = (r: Request, env: 'request' | 'batch' | 'webhook', where: string): CompiledRequest => {
    if (!r.path.startsWith('/')) problems.push(`${where}.path: must start with "/"`)
    return {
      method: r.method,
      path: compile(env, r.path, `${where}.path`, true),
      query: Object.entries(r.query).map(([k, v]) => [k, compile(env, v, `${where}.query.${k}`)]),
      headers: compileHeaders(r.headers, env, `${where}.headers`),
      ...(r.body !== undefined && { body: compile(env, r.body, `${where}.body`) }),
    }
  }

  const compileTarget = (
    r: { method?: TargetRequest['method']; path: string; query: Record<string, string>; body?: string },
    env: 'request' | 'record' | 'webhook',
    where: string,
  ): CompiledTargetRequest => {
    if (!r.path.startsWith('/')) problems.push(`${where}.path: must start with "/"`)
    // Holes are URL-encoded; literal text must not climb out of the target root.
    const literal = r.path.replace(/\{[^}]*\}/g, 'x')
    if (r.path.split(/[/?]/).some((seg) => seg === '..' || seg === '.')) problems.push(`${where}.path: "." and ".." segments are not allowed`)
    else if (r.path.startsWith('//') || /[\\#?%\s]/.test(literal)) problems.push(`${where}.path: must not start with "//" or contain "\\", "#", "?", "%" or spaces`)
    return {
      method: r.method ?? 'GET',
      path: compile(env, r.path, `${where}.path`, true),
      query: Object.entries(r.query).map(([k, v]) => [k, compile(env, v, `${where}.query.${k}`)]),
      ...(r.body !== undefined && { body: compile(env, r.body, `${where}.body`) }),
    }
  }

  const scopes = plugin.hosts.map((h) => {
    const url = new URL(h)
    if (url.search || url.hash) problems.push(`hosts: ${h} must not have a query or fragment`)
    return { origin: url.origin, path: url.pathname.replace(/\/+$/, '') }
  })
  const baseUrl = plugin.hosts[0]!.replace(/\/+$/, '')
  const auth = compileAuth(plugin.auth, (s, w) => compile('auth', s, `auth.${w}`))
  if (auth.type === 'oauth2_client_credentials') {
    const tokenUrl = new URL(auth.tokenUrl.startsWith('/') ? baseUrl + auth.tokenUrl : auth.tokenUrl)
    auth.tokenUrl = tokenUrl.toString()
    const inScope = scopes.some((s) => s.origin === tokenUrl.origin && (s.path === '' || tokenUrl.pathname.startsWith(`${s.path}/`)))
    if (!inScope) problems.push(`auth.token_url: ${tokenUrl.origin}${tokenUrl.pathname} is not under hosts`)
  }

  const headers = compileHeaders(plugin.headers, 'auth', 'headers')

  for (const [entity, fields] of Object.entries(plugin.owns)) {
    const def = pack?.entities[entity]
    if (!pack) continue
    if (!def) problems.push(`owns.${entity}: unknown entity`)
    else for (const f of fields) if (!(f in def.fields)) problems.push(`owns.${entity}: unknown field ${f}`)
  }

  const sources = new Map<string, CompiledSource>()
  for (const [name, s] of Object.entries(plugin.sources)) {
    const where = `sources.${name}`
    if (s.request.method !== 'GET' && s.request.method !== 'POST') {
      problems.push(`${where}.request.method: sources read, so only GET and POST are allowed`)
    }
    const emits: CompiledEmit[] = s.emit.map((e, i) => {
      const w = `${where}.emit[${i}]`
      const op = pack?.operations[e.operation]
      const entity = op && pack?.entities[op.entity]
      if (!op || !entity) {
        problems.push(`${w}: unknown operation ${e.operation}`)
        return { operation: e.operation, entity: '', kind: 'upsert', keyFields: [], types: {}, fields: [] }
      }
      for (const f of Object.keys(e.fields)) if (!(f in entity.fields)) problems.push(`${w}: ${op.entity} has no field ${f}`)
      for (const k of entity.key) if (!(k in e.fields)) problems.push(`${w}: missing key field ${k}`)
      return {
        operation: e.operation,
        entity: op.entity,
        kind: op.kind,
        keyFields: entity.key,
        types: Object.fromEntries(Object.keys(e.fields).map((f) => [f, entity.fields[f] ?? 'json'])),
        ...(e.when !== undefined && { when: compile('record', e.when, `${w}.when`) }),
        fields: Object.entries(e.fields).map(([f, x]) => [f, compile('record', x, `${w}.fields.${f}`)]),
      }
    })
    sources.set(name, {
      name,
      request: compileRequest(s.request, 'request', `${where}.request`),
      paginate: s.paginate,
      ...(s.paginate.type === 'cursor' && { next: compile('response', s.paginate.next, `${where}.paginate.next`) }),
      records: compile('response', s.records, `${where}.records`),
      ...(s.when !== undefined && { when: compile('record', s.when, `${where}.when`) }),
      emits,
      ...(s.call && { call: compileTarget(s.call, 'record', `${where}.call`) }),
      ...(s.cursor && { cursor: compile('cursor', s.cursor.value, `${where}.cursor.value`) }),
    })
  }

  const sinks = new Map<string, CompiledSink>()
  for (const [name, s] of Object.entries(plugin.sinks)) {
    const where = `sinks.${name}`
    const common = {
      name,
      on: s.on,
      after: s.after,
      onDelete: s.on_delete,
      batchSize: s.batch.size,
    }
    if (s.read) {
      {
        const read: CompiledSinkRead = {
          request: compileTarget(s.read, 'request', `${where}.read`),
          records: compile('response', s.read.records, `${where}.read.records`),
          paginate: s.read.paginate,
          ...(s.read.paginate.type === 'cursor' && { next: compile('response', s.read.paginate.next, `${where}.read.paginate.next`) }),
        }
        sinks.set(name, {
          ...common,
          mode: 'target',
          read,
          key: compile('row', s.key!, `${where}.key`),
          fields: s.fields ?? null,
          ...(s.where !== undefined && { where: compile('row', s.where, `${where}.where`) }),
          ...(s.skip !== undefined && { skip: compile('row', s.skip, `${where}.skip`) }),
          ...(s.batch.by !== undefined && { by: compile('row', s.batch.by, `${where}.batch.by`) }),
          request: compileRequest(s.request, 'batch', `${where}.request`),
          ...(s.ack !== undefined && { ack: compile('ack', s.ack, `${where}.ack`) }),
        })
      }
      continue
    }
    const input = s.input!
    if (s.key !== undefined || s.fields !== undefined || s.where !== undefined) {
      problems.push(`${where}: key, fields and where belong to sinks with read; use input.where`)
    }
    const entity = pack?.entities[input.entity]
    if (!pack) continue
    if (!entity) {
      problems.push(`${where}.input.entity: unknown entity ${input.entity}`)
      continue
    }
    for (const f of input.fields) if (!(f in entity.fields)) problems.push(`${where}.input.fields: unknown field ${f}`)
    const owned = new Set(plugin.owns[input.entity] ?? [])
    for (const f of input.fields) {
      if (owned.has(f)) problems.push(`${where}.input.fields: ${f} is owned by this plugin, so writing it back would echo`)
    }
    const visible = [...new Set([...entity.key, ...input.fields])]
    /** Rows are visible as `row`, and in requests as `batch.changes[].row` and `.previous`. */
    const checkRow = (expr: CompiledExpression, w: string) => {
      for (const ref of expr.refs) {
        const m = /^(?:row|batch\.changes\[\]\.(?:row|previous))\.([^.[]+)/.exec(ref)
        if (m && !visible.includes(m[1]!)) problems.push(`${w}: ${ref} is not in the declared input`)
      }
      return expr
    }
    const checkRequest = (r: CompiledRequest, w: string) => {
      for (const [part, expr] of [['path', r.path], ...r.query, ...r.headers, ...(r.body ? [['body', r.body] as const] : [])] as const) {
        checkRow(expr, `${w}.${part}`)
      }
      return r
    }
    sinks.set(name, {
      ...common,
      mode: 'domain',
      entity: input.entity,
      keyFields: entity.key,
      visibleFields: visible,
      declaredFields: input.fields,
      ...(input.where !== undefined && { where: checkRow(compile('row', input.where, `${where}.input.where`), `${where}.input.where`) }),
      ...(s.skip !== undefined && { skip: checkRow(compile('row', s.skip, `${where}.skip`), `${where}.skip`) }),
      ...(s.batch.by !== undefined && { by: checkRow(compile('row', s.batch.by, `${where}.batch.by`), `${where}.batch.by`) }),
      request: checkRequest(compileRequest(s.request, 'batch', `${where}.request`), `${where}.request`),
      ...(s.ack !== undefined && { ack: checkRow(compile('ack', s.ack, `${where}.ack`), `${where}.ack`) }),
    })
  }

  for (const [name, s] of Object.entries(plugin.sinks)) {
    for (const a of s.after) {
      if (a === name) problems.push(`sinks.${name}.after: a sink cannot run after itself`)
      else if (!(a in plugin.sinks)) problems.push(`sinks.${name}.after: unknown sink ${a}`)
    }
  }
  const cycle = findCycle(Object.fromEntries(Object.entries(plugin.sinks).map(([n, s]) => [n, s.after])))
  if (cycle) problems.push(`sinks: after forms a cycle: ${cycle.join(' → ')}`)

  const webhooks = new Map<string, CompiledWebhook>()
  for (const [name, w] of Object.entries(plugin.webhooks)) {
    const where = `webhooks.${name}`
    if (webhooks.has(w.path)) problems.push(`${where}.path: ${w.path} is used by webhooks.${webhooks.get(w.path)!.name}`)
    if (w.reread) {
      const source = plugin.sources[w.reread.source]
      if (!source) problems.push(`${where}.reread.source: unknown source ${w.reread.source}`)
      else if (!source.call) problems.push(`${where}.reread.source: ${w.reread.source} has no call`)
      if (w.reread.request.method !== 'GET' && w.reread.request.method !== 'POST') {
        problems.push(`${where}.reread.request.method: a reread reads, so only GET and POST are allowed`)
      }
    }
    for (const sink of w.resend ?? []) if (!(sink in plugin.sinks)) problems.push(`${where}.resend: unknown sink ${sink}`)
    webhooks.set(w.path, {
      name,
      path: w.path,
      ...(w.ping !== undefined && { ping: compile('webhookKey', w.ping, `${where}.ping`) }),
      binding: compile('webhookKey', w.binding, `${where}.binding`),
      verify: compile('webhookVerify', w.verify, `${where}.verify`),
      ...(w.when !== undefined && { when: compile('webhook', w.when, `${where}.when`) }),
      ...(w.dedupe_key !== undefined && { dedupeKey: compile('webhookKey', w.dedupe_key, `${where}.dedupe_key`) }),
      ...(w.order !== undefined && { order: compile('webhookKey', w.order, `${where}.order`) }),
      ...(w.call && { call: compileTarget(w.call, 'webhook', `${where}.call`) }),
      ...(w.reread && {
        reread: {
          source: w.reread.source,
          request: compileRequest(w.reread.request, 'webhook', `${where}.reread.request`),
          ...(w.reread.records !== undefined && { records: compile('webhookResponse', w.reread.records, `${where}.reread.records`) }),
        },
      }),
      ...(w.resend && { resend: w.resend }),
      ...(w.issue !== undefined && { issue: compile('webhook', w.issue, `${where}.issue`) }),
    })
  }

  if (problems.length > 0) throw new PluginValidationError(problems)
  return { declaration: plugin, domain: pack, scopes, baseUrl, auth, headers, sources, sinks, webhooks }
}

/** The first cycle in a dependency graph, as a path that returns to its start, or null. */
function findCycle(graph: Record<string, string[]>): string[] | null {
  const state = new Map<string, 'visiting' | 'done'>()
  const path: string[] = []
  const visit = (node: string): string[] | null => {
    if (state.get(node) === 'done') return null
    if (state.get(node) === 'visiting') return [...path.slice(path.indexOf(node)), node]
    state.set(node, 'visiting')
    path.push(node)
    for (const next of graph[node] ?? []) {
      if (!(next in graph) || next === node) continue
      const found = visit(next)
      if (found) return found
    }
    path.pop()
    state.set(node, 'done')
    return null
  }
  for (const node of Object.keys(graph)) {
    const found = visit(node)
    if (found) return found
  }
  return null
}

/**
 * Turns expression failures at run time into `permanent` errors that say where
 * they happened, and refuses results too large to be reasonable.
 */
function guard(expr: CompiledExpression, where: string, maxSize: number): CompiledExpression {
  return {
    source: expr.source,
    refs: expr.refs,
    evaluate(context) {
      let value: unknown
      try {
        value = expr.evaluate(context)
      } catch (e) {
        throw new ConnectorError('permanent', `${where}: ${e instanceof Error ? e.message : String(e)}`, { cause: e })
      }
      if (sizeOf(value, maxSize) > maxSize) throw new ConnectorError('permanent', `${where}: result is larger than ${maxSize} units`)
      return value
    },
  }
}

/** Characters plus elements, stopping early once past `limit`. */
function sizeOf(value: unknown, limit: number): number {
  let total = 0
  const stack: unknown[] = [value]
  while (stack.length > 0 && total <= limit) {
    const v = stack.pop()
    total += 1
    if (typeof v === 'string') total += v.length
    else if (Array.isArray(v)) stack.push(...v)
    else if (v !== null && typeof v === 'object') {
      for (const [k, x] of Object.entries(v)) {
        total += k.length
        stack.push(x)
      }
    }
  }
  return total
}

function compileAuth(a: Auth, compile: (source: string, where: string) => CompiledExpression): CompiledAuth {
  switch (a.type) {
    case 'none':
      return a
    case 'api_key':
      return { type: 'api_key', in: a.in, name: a.name, value: compile(a.value, 'value') }
    case 'bearer':
      return { type: 'bearer', token: compile(a.token, 'token') }
    case 'basic':
      return { type: 'basic', username: compile(a.username, 'username'), password: compile(a.password, 'password') }
    case 'oauth2_client_credentials':
      return {
        type: a.type,
        tokenUrl: a.token_url,
        clientId: compile(a.client_id, 'client_id'),
        clientSecret: compile(a.client_secret, 'client_secret'),
        ...(a.scope !== undefined && { scope: a.scope }),
        style: a.style,
        defaultTtlS: a.default_ttl_s,
        notBeforeMs: a.not_before_ms,
      }
  }
}
