import { CelEnvironment, ExpressionError, type CelType, type CompiledExpression } from '@connector-hub/cel'
import {
  DomainPack,
  ENGINE_CONTRACT,
  Plugin,
  satisfies,
  type Auth,
  type Paginate,
  type PluginInput,
  type Request,
} from '@connector-hub/spec'
import { z } from 'zod'
import { PluginValidationError } from './errors.js'

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
  readonly origins: ReadonlySet<string>
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
        if (root === 'config' && key && !configKeys.has(key)) {
          problems.push(`${where}: config.${key} is not a declared non-secret config field`)
        }
        if (root === 'secrets' && key && !secretKeys.has(key)) {
          problems.push(`${where}: secrets.${key} is not a declared secret config field`)
        }
      }
      return expr
    } catch (e) {
      problems.push(`${where}: ${e instanceof ExpressionError ? e.message : String(e)} in \`${source}\``)
      return { source, refs: new Set(), evaluate: () => undefined }
    }
  }

  const compileRequest = (r: Request, env: 'request' | 'batch', where: string): CompiledRequest => {
    if (!r.path.startsWith('/')) problems.push(`${where}.path: must start with "/"`)
    return {
      method: r.method,
      path: compile(env, r.path, `${where}.path`, true),
      query: Object.entries(r.query).map(([k, v]) => [k, compile(env, v, `${where}.query.${k}`)]),
      headers: Object.entries(r.headers).map(([k, v]) => [k, compile(env, v, `${where}.headers.${k}`)]),
      ...(r.body !== undefined && { body: compile(env, r.body, `${where}.body`) }),
    }
  }

  const origins = new Set(plugin.hosts.map((h) => new URL(h).origin))
  const baseUrl = plugin.hosts[0]!.replace(/\/$/, '')
  const auth = compileAuth(plugin.auth, (s, w) => compile('auth', s, `auth.${w}`))
  if (auth.type === 'oauth2_client_credentials') {
    const tokenUrl = new URL(auth.tokenUrl, `${baseUrl}/`)
    if (!origins.has(tokenUrl.origin)) problems.push(`auth.token_url: ${tokenUrl.origin} is not in hosts`)
  }

  for (const [entity, fields] of Object.entries(plugin.owns)) {
    const def = domain.entities[entity]
    if (!def) problems.push(`owns.${entity}: unknown entity`)
    else for (const f of fields) if (!(f in def.fields)) problems.push(`owns.${entity}: unknown field ${f}`)
  }

  const sources = new Map<string, CompiledSource>()
  for (const [name, s] of Object.entries(plugin.sources)) {
    const where = `sources.${name}`
    const emits: CompiledEmit[] = s.emit.map((e, i) => {
      const w = `${where}.emit[${i}]`
      const op = domain.operations[e.operation]
      const entity = op && domain.entities[op.entity]
      if (!op || !entity) {
        problems.push(`${w}: unknown operation ${e.operation}`)
        return { operation: e.operation, entity: '', kind: 'upsert', keyFields: [], fields: [] }
      }
      for (const f of Object.keys(e.fields)) if (!(f in entity.fields)) problems.push(`${w}: ${op.entity} has no field ${f}`)
      for (const k of entity.key) if (!(k in e.fields)) problems.push(`${w}: missing key field ${k}`)
      return {
        operation: e.operation,
        entity: op.entity,
        kind: op.kind,
        keyFields: entity.key,
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
    const checkRow = (expr: CompiledExpression, w: string) => {
      for (const ref of expr.refs) {
        const [root, field] = ref.split('.')
        if (root === 'row' && field && !visible.includes(field)) problems.push(`${w}: row.${field} is not in the declared input`)
      }
      return expr
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
      request: compileRequest(s.request, 'batch', `${where}.request`),
      ...(s.ack !== undefined && { ack: compile('ack', s.ack, `${where}.ack`) }),
    })
  }

  if (problems.length > 0) throw new PluginValidationError(problems)
  return { declaration: plugin, domain, origins, baseUrl, auth, sources, sinks }
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
