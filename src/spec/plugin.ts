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
    /** Wait this long before using a new token; some providers reject one used at once. */
    not_before_ms: z.number().int().min(0).max(10_000).default(0),
  }),
])
export type Auth = z.infer<typeof Auth>

/** Plugins may lower these freely; the upper bounds keep one plugin from monopolising a host. */
export const Limits = z.object({
  timeout_ms: z.number().int().positive().max(120_000).default(15_000),
  max_body_bytes: z.number().int().positive().max(64 * 1024 * 1024).default(8 * 1024 * 1024),
  max_pages: z.number().int().positive().max(100_000).default(1_000),
  max_records: z.number().int().positive().max(1_000_000).default(100_000),
  /** Requests per minute across every binding of this plugin. */
  requests_per_minute: z.number().int().positive().optional(),
})
export type Limits = z.infer<typeof Limits>

export const Request = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  /** Path template relative to the first host, e.g. `/v1/listings/{batch.key}/calendar`. Sources may only GET or POST. */
  path: Template,
  query: z.record(z.string(), Cel).default({}),
  headers: z.record(z.string(), Cel).default({}),
  /** CEL producing the JSON body. */
  body: Cel.optional(),
})
export type Request = z.infer<typeof Request>

/**
 * A request to the host's own API, the target, e.g. Propool's public API. The host adds its
 * base URL and the credentials of this install; the plugin never sees them.
 */
export const TargetRequest = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).default('GET'),
  /** Path template relative to the target API root, e.g. `/rental-units/{config.unit_id}/calendar`. */
  path: Template,
  query: z.record(z.string(), Cel).default({}),
  /** CEL producing the JSON body. */
  body: Cel.optional(),
})
export type TargetRequest = z.infer<typeof TargetRequest>

export const Paginate = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }),
  /** Exposes `page.offset` and `page.limit`; stops on an empty page. */
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

export const Source = z
  .object({
    description: z.string().optional(),
    request: Request,
    paginate: Paginate.default({ type: 'none' }),
    /** CEL over `response` producing the list of provider records on this page. */
    records: Cel,
    /** CEL over `record`, `config`, `cursor`, `now`. Records where it is false are skipped. */
    when: Cel.optional(),
    /** Domain operations per record. A source has `emit` or `call`, not both. */
    emit: z.array(Emit).default([]),
    /** One target API request per record, e.g. an upsert into the host. Variables as for `when`. */
    call: TargetRequest.optional(),
    /**
     * Incremental sync. `value` is CEL over `record`; the engine keeps the highest
     * value seen and exposes it as `cursor` on the next run, committed in the same
     * transaction as the operations.
     */
    cursor: z.object({ value: Cel }).optional(),
    /** Filters the provider supports, so the engine can fetch only changes. */
    filters: z.array(z.string()).default([]),
  })
  .refine((s) => (s.emit.length > 0) !== (s.call !== undefined), { message: 'a source needs either emit or call' })
export type Source = z.infer<typeof Source>

/** Reads a sink's rows from the target API. Every page is read before anything is sent. */
export const SinkRead = z.object({
  path: Template,
  /** CEL over `config`, `page`, `now`. */
  query: z.record(z.string(), Cel).default({}),
  /** CEL over `response` producing the rows on this page. */
  records: Cel,
  paginate: Paginate.default({ type: 'none' }),
})
export type SinkRead = z.infer<typeof SinkRead>

export const Sink = z
  .object({
    description: z.string().optional(),
    /** Domain mode: the declared input, which entity and fields this sink reads. Nothing else is visible. */
    input: z
      .object({
        entity: name,
        fields: z.array(z.string()).min(1),
        /** CEL over `row`, applied by the engine after reading. */
        where: Cel.optional(),
      })
      .optional(),
    /** Target mode: rows come from the target API instead of the host's `read` port. */
    read: SinkRead.optional(),
    /** Target mode: CEL over `row` giving its stable key, e.g. `row.date`. */
    key: Cel.optional(),
    /** Target mode: the row fields compared with, and saved as, the last write. Default: the whole row. */
    fields: z.array(z.string()).min(1).optional(),
    /** Target mode: CEL over `row`. Rows where it is false count as absent. */
    where: Cel.optional(),
    /**
     * CEL over `row`. Rows where it is true are left alone: not sent, and not treated as deleted.
     * An echo guard, e.g. nights the provider itself booked.
     */
    skip: Cel.optional(),
    /** Host event names that should run this sink, e.g. `calendar.updated`. The engine only reports them. */
    on: z.array(z.string()).default([]),
    /** Sinks that must run first when both run, e.g. the listing before its calendar. */
    after: z.array(name).default([]),
    /**
     * `send`: a row written before and now absent is sent once more as a change with
     * `deleted: true` and its last written values, then forgotten. `ignore`: it is just forgotten.
     */
    on_delete: z.enum(['ignore', 'send']).default('ignore'),
    batch: z
      .object({
        size: z.number().int().positive().default(50),
        /** CEL over `row` grouping rows that must share one request, e.g. a listing ID. */
        by: Cel.optional(),
      })
      .default({ size: 50 }),
    /**
     * Target mode: read the provider's current values before each batch and send only the changes
     * `allow` accepts, so an edit made at the provider since the last write is not overwritten.
     * Refused changes are reported as conflicts and not saved, so the next run checks them again.
     */
    precheck: z
      .object({
        /** Provider request, variables as for `request`. */
        request: Request,
        /** CEL over `response`, `batch`, `config`, `now`: the provider's records. */
        records: Cel,
        /** CEL over `remote`: a record's key, the same value as the sink's `key`. */
        key: Cel,
        /** CEL over `change` (`{row, previous, deleted}`), `remote` (the record or null), `config`, `now`. */
        allow: Cel,
      })
      .optional(),
    /**
     * Variables: `batch.key`, `batch.changes` (list of `{row, previous, deleted}`, plus `remote`
     * with a precheck), `config`, `now`.
     */
    request: Request,
    /** CEL over `response`; false fails the batch as permanent. Defaults to any 2xx. */
    ack: Cel.optional(),
  })
  .refine((s) => (s.input !== undefined) !== (s.read !== undefined), {
    message: 'a sink needs either input or read',
  })
  .refine((s) => s.read === undefined || s.key !== undefined, {
    message: 'a sink with read needs key',
  })
export type Sink = z.infer<typeof Sink>

/**
 * An incoming provider webhook. The host routes a request to it by `path` and the engine answers:
 * `ping` probes are acknowledged, the binding is found and the request verified, then exactly one
 * action runs: `call` the target, `reread` the record from the provider, `resend` sinks, or `issue`.
 */
export const Webhook = z
  .object({
    description: z.string().optional(),
    /** Path under the host's webhook URL for this plugin, e.g. `/sync`. Unique per plugin. */
    path: z.string().regex(/^\/[a-z0-9_-]+(\/[a-z0-9_-]+)*$/, 'use a path like /sync'),
    /** CEL over `request`: true answers a provider's URL probe without verifying or acting. */
    ping: Cel.optional(),
    /**
     * CEL over `request`, checked before the binding is looked up: false acknowledges and ignores
     * the request. For providers that post every event of an account to one URL.
     */
    filter: Cel.optional(),
    /** CEL over `request` giving the key the host finds the binding by, e.g. the provider listing id. */
    binding: Cel,
    /**
     * `ignore` acknowledges a request whose binding is unknown or unreadable instead of refusing
     * it, for account-wide webhooks that also carry listings no binding covers.
     */
    unknown_binding: z.enum(['refuse', 'ignore']).default('refuse'),
    /** CEL over `request`, `config`, `secrets`, `now`; must be true. Use `secureEquals` for comparisons. */
    verify: Cel,
    /** CEL over `request`, `config`, `now`. Requests where it is false are acknowledged and ignored. */
    when: Cel.optional(),
    /** CEL over `request`: a delivery id. A key already handled is acknowledged and ignored. */
    dedupe_key: Cel.optional(),
    /** CEL over `request`: a value that must grow, e.g. a batch time. Older or equal requests are ignored. */
    order: Cel.optional(),
    /** Variables `request`, `config`, `now`. */
    call: TargetRequest.optional(),
    /** The payload is only a signal: read the record from the provider and run the source's `call` on it. */
    reread: z
      .object({
        source: name,
        /** Provider request, variables `request`, `config`, `now`. */
        request: Request,
        /** CEL over `response` giving the records; defaults to the source's `records`. */
        records: Cel.optional(),
      })
      .optional(),
    /** Sinks whose snapshots are forgotten, so their next run sends everything. The host runs them. */
    resend: z.array(name).min(1).optional(),
    /** CEL over `request`, `config`, `now`: a message for the host to show as a problem with the binding. */
    issue: Cel.optional(),
  })
  .refine((w) => [w.call, w.reread, w.resend, w.issue].filter((a) => a !== undefined).length === 1, {
    message: 'a webhook needs exactly one of call, reread, resend or issue',
  })
export type Webhook = z.infer<typeof Webhook>

export const Plugin = z.object({
  plugin: z.string().regex(/^[a-z][a-z0-9-]*$/, 'use lower-kebab-case'),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, 'use semver, e.g. 1.0.0'),
  description: z.string().optional(),
  /** Engine contract this plugin was written for, as a caret range, e.g. `^0.1`. */
  engine: z.string(),
  /** Domain pack the plugin's `emit` and `input` use. Not needed when it only talks to the target API. */
  domain: z.object({ name: z.string(), version: z.string() }).optional(),
  /** Every host the plugin may call. Requests to any other host are refused. */
  hosts: z.array(z.url({ protocol: /^https?$/ })).min(1),
  config: z.record(name, ConfigField).default({}),
  auth: Auth.default({ type: 'none' }),
  /** Headers on every provider request, CEL over `secrets` and `config`. */
  headers: z.record(z.string(), Cel).default({}),
  limits: Limits.default(Limits.parse({})),
  /** Entity → fields this plugin is the source of truth for. */
  owns: z.record(name, z.array(z.string())).default({}),
  sources: z.record(name, Source).default({}),
  sinks: z.record(name, Sink).default({}),
  webhooks: z.record(name, Webhook).default({}),
})
export type Plugin = z.infer<typeof Plugin>
export type PluginInput = z.input<typeof Plugin>
