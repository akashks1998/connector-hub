import { CelEnvironment, ExpressionError, type CelType, type CompiledExpression } from '../cel/index.js'
import {
  DomainPack,
  ENGINE_CONTRACT,
  Plugin,
  satisfies,
  type Auth,
  type FieldDef,
  type Paginate,
  type PluginInput,
  type Request,
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

export interface CompiledSource {
  name: string
  request: CompiledRequest
  paginate: Paginate
  next?: CompiledExpression
  records: CompiledExpression
  emits: CompiledEmit[]
  cursor?: CompiledExpression
}

export interface CompiledSink {
  name: string
  entity: string
  keyFields: string[]
  /** Exactly the fields the sink may see: its declared fields plus the entity key. */
  visibleFields: string[]
  declaredFields: string[]
  where?: CompiledExpression
  batchSize: number
  by?: CompiledExpression
  request: CompiledRequest
  ack?: CompiledExpression
}

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
    }

export interface CompiledPlugin {
  readonly declaration: Plugin
  readonly domain: DomainPack
  /** Origin and path prefix of each host. Requests must fall under one of them. */
  readonly scopes: ReadonlyArray<{ origin: string; path: string }>
  readonly baseUrl: string
  readonly auth: CompiledAuth
  readonly sources: ReadonlyMap<string, CompiledSource>
  readonly sinks: ReadonlyMap<string, CompiledSink>
}

const envs = {
  auth: { secrets: 'map', config: 'map' },
  request: { config: 'map', cursor: 'dyn', page: 'map' },
  response: { response: 'map', config: 'map', cursor: 'dyn', page: 'map' },
  record: { record: 'map', config: 'map', cursor: 'dyn' },
  cursor: { record: 'map' },
  row: { row: 'map', config: 'map' },
  batch: { batch: 'map', config: 'map' },
  ack: { response: 'map', batch: 'map', config: 'map' },
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
export function compilePlugin(input: PluginInput | unknown, domainInput: DomainPack | unknown): CompiledPlugin {
  const domainResult = DomainPack.safeParse(domainInput)
  if (!domainResult.success) throw new PluginValidationError([`domain pack: ${z.prettifyError(domainResult.error)}`])
  const domain = domainResult.data

  const parsed = Plugin.safeParse(input)
  if (!parsed.success) throw new PluginValidationError(z.prettifyError(parsed.error).split('\n').filter(Boolean))
  const plugin = parsed.data

  const problems: string[] = []
  const cel = Object.fromEntries(Object.entries(envs).map(([k, v]) => [k, new CelEnvironment({ variables: v })])) as Record<
    keyof typeof envs,
    CelEnvironment
  >

  if (!satisfies(ENGINE_CONTRACT, plugin.engine)) {
    problems.push(`engine: plugin needs ${plugin.engine}, this engine implements ${ENGINE_CONTRACT}`)
  }
  if (plugin.domain.name !== domain.domain || !satisfies(domain.version, plugin.domain.version)) {
    problems.push(`domain: plugin needs ${plugin.domain.name} ${plugin.domain.version}, got ${domain.domain} ${domain.version}`)
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

  const compileRequest = (r: Request, env: 'request' | 'batch', where: string): CompiledRequest => {
    if (!r.path.startsWith('/')) problems.push(`${where}.path: must start with "/"`)
    for (const name of Object.keys(r.headers)) {
      const lower = name.toLowerCase()
      if (!HEADER_NAME.test(lower)) problems.push(`${where}.headers: ${JSON.stringify(name)} is not a valid header name`)
      else if (RESERVED_HEADERS.has(lower)) problems.push(`${where}.headers: ${lower} is set by the engine or host`)
    }
    return {
      method: r.method,
      path: compile(env, r.path, `${where}.path`, true),
      query: Object.entries(r.query).map(([k, v]) => [k, compile(env, v, `${where}.query.${k}`)]),
      headers: Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), compile(env, v, `${where}.headers.${k}`)]),
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

  for (const [entity, fields] of Object.entries(plugin.owns)) {
    const def = domain.entities[entity]
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
      const op = domain.operations[e.operation]
      const entity = op && domain.entities[op.entity]
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
      emits,
      ...(s.cursor && { cursor: compile('cursor', s.cursor.value, `${where}.cursor.value`) }),
    })
  }

  const sinks = new Map<string, CompiledSink>()
  for (const [name, s] of Object.entries(plugin.sinks)) {
    const where = `sinks.${name}`
    const entity = domain.entities[s.input.entity]
    if (!entity) {
      problems.push(`${where}.input.entity: unknown entity ${s.input.entity}`)
      continue
    }
    for (const f of s.input.fields) if (!(f in entity.fields)) problems.push(`${where}.input.fields: unknown field ${f}`)
    const owned = new Set(plugin.owns[s.input.entity] ?? [])
    for (const f of s.input.fields) {
      if (owned.has(f)) problems.push(`${where}.input.fields: ${f} is owned by this plugin, so writing it back would echo`)
    }
    const visible = [...new Set([...entity.key, ...s.input.fields])]
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
      name,
      entity: s.input.entity,
      keyFields: entity.key,
      visibleFields: visible,
      declaredFields: s.input.fields,
      ...(s.input.where !== undefined && { where: checkRow(compile('row', s.input.where, `${where}.input.where`), `${where}.input.where`) }),
      batchSize: s.batch.size,
      ...(s.batch.by !== undefined && { by: checkRow(compile('row', s.batch.by, `${where}.batch.by`), `${where}.batch.by`) }),
      request: checkRequest(compileRequest(s.request, 'batch', `${where}.request`), `${where}.request`),
      ...(s.ack !== undefined && { ack: checkRow(compile('ack', s.ack, `${where}.ack`), `${where}.ack`) }),
    })
  }

  if (problems.length > 0) throw new PluginValidationError(problems)
  return { declaration: plugin, domain, scopes, baseUrl, auth, sources, sinks }
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
      }
  }
}
