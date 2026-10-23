import { z } from 'zod'

/**
 * Every string described as "CEL" is a Common Expression Language expression,
 * compiled and type-checked before the plugin can run. Templates (request paths)
 * are literal text with `{expr}` holes, where each hole is CEL.
 */
const Cel = z.string().min(1)
const Template = z.string().min(1)
const name = z.string().regex(/^[a-z][a-z0-9_]*$/, 'use lower_snake_case')

export const ConfigField = z.object({
  type: z.enum(['string', 'int', 'bool']).default('string'),
  required: z.boolean().default(true),
  /** Secret fields are stored by the host's credential store, never in plain config. */
  secret: z.boolean().default(false),
  description: z.string().optional(),
})
export type ConfigField = z.infer<typeof ConfigField>

export const Auth = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  z.object({
    type: z.literal('api_key'),
    in: z.enum(['header', 'query']).default('header'),
    name: z.string(),
    value: Cel,
  }),
  z.object({ type: z.literal('bearer'), token: Cel }),
  z.object({ type: z.literal('basic'), username: Cel, password: Cel }),
  z.object({
    type: z.literal('oauth2_client_credentials'),
    token_url: z.string(),
    client_id: Cel,
    client_secret: Cel,
    scope: z.string().optional(),
    /** `form` sends credentials in the body, `basic` in an Authorization header. */
    style: z.enum(['form', 'basic']).default('form'),
    /** Used when the token response has no `expires_in`. */
    default_ttl_s: z.number().int().positive().default(3600),
  }),
])
export type Auth = z.infer<typeof Auth>

export const Limits = z.object({
  timeout_ms: z.number().int().positive().default(15_000),
  max_body_bytes: z.number().int().positive().default(8 * 1024 * 1024),
  max_pages: z.number().int().positive().default(1_000),
  max_records: z.number().int().positive().default(100_000),
  /** Requests per minute across every binding of this plugin. */
  requests_per_minute: z.number().int().positive().optional(),
})
export type Limits = z.infer<typeof Limits>

export const Request = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  /** Path template relative to the first host, e.g. `/v1/listings/{row.listing_id}/calendar`. */
  path: Template,
  query: z.record(z.string(), Cel).default({}),
  headers: z.record(z.string(), Cel).default({}),
  /** CEL producing the JSON body. */
  body: Cel.optional(),
})
export type Request = z.infer<typeof Request>

export const Paginate = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  /** Exposes `page.offset` and `page.limit`; stops when a page has fewer than `limit` records. */
  z.object({ type: z.literal('offset'), limit: z.number().int().positive() }),
  /** Exposes `page.number`; stops on an empty page. */
  z.object({ type: z.literal('page'), start: z.number().int().default(1) }),
  /** Exposes `page.cursor`; `next` is CEL over `response` and stops when it is null or "". */
  z.object({ type: z.literal('cursor'), next: Cel }),
])
export type Paginate = z.infer<typeof Paginate>

export const Emit = z.object({
  /** An operation declared by the domain pack. */
  operation: name,
  /** CEL over `record`, `config`, `cursor`. Records where it is false are skipped. */
  when: Cel.optional(),
  /** Entity field → CEL over `record`. Must cover the entity key. */
  fields: z.record(z.string(), Cel),
})
export type Emit = z.infer<typeof Emit>

export const Source = z.object({
  description: z.string().optional(),
  request: Request,
  paginate: Paginate.default({ type: 'none' }),
  /** CEL over `response` producing the list of provider records on this page. */
  records: Cel,
  emit: z.array(Emit).min(1),
  /**
   * Incremental sync. `value` is CEL over `record`; the engine keeps the highest
   * value seen and exposes it as `cursor` on the next run, committed in the same
   * transaction as the operations.
   */
  cursor: z.object({ value: Cel }).optional(),
  /** Filters the provider supports, so the engine can fetch only changes. */
  filters: z.array(z.string()).default([]),
})
export type Source = z.infer<typeof Source>

export const Sink = z.object({
  description: z.string().optional(),
  /** The declared input: which entity and fields this sink reads. Nothing else is visible. */
  input: z.object({
    entity: name,
    fields: z.array(z.string()).min(1),
    /** CEL over `row`, applied by the engine after reading. */
    where: Cel.optional(),
  }),
  batch: z
    .object({
      size: z.number().int().positive().default(50),
      /** CEL over `row` grouping rows that must share one request, e.g. a listing ID. */
      by: Cel.optional(),
    })
    .default({ size: 50 }),
  /** Variables: `batch.key`, `batch.changes` (list of `{key, row, previous}`), `config`. */
  request: Request,
  /** CEL over `response`; false fails the batch as permanent. Defaults to any 2xx. */
  ack: Cel.optional(),
})
export type Sink = z.infer<typeof Sink>

export const Plugin = z.object({
  plugin: z.string().regex(/^[a-z][a-z0-9-]*$/, 'use lower-kebab-case'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'use semver, e.g. 1.0.0'),
  description: z.string().optional(),
  /** Engine contract this plugin was written for, as a caret range, e.g. `^0.1`. */
  engine: z.string(),
  domain: z.object({ name: z.string(), version: z.string() }),
  /** Every host the plugin may call. Requests to any other host are refused. */
  hosts: z.array(z.url({ protocol: /^https?$/ })).min(1),
  config: z.record(name, ConfigField).default({}),
  auth: Auth.default({ type: 'none' }),
  limits: Limits.default(Limits.parse({})),
  /** Entity → fields this plugin is the source of truth for. */
  owns: z.record(name, z.array(z.string())).default({}),
  sources: z.record(name, Source).default({}),
  sinks: z.record(name, Sink).default({}),
})
export type Plugin = z.infer<typeof Plugin>
export type PluginInput = z.input<typeof Plugin>
