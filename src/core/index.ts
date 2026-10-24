export { compilePlugin } from './compile.js'
export type {
  CompiledAuth,
  CompiledDomainSink,
  CompiledEmit,
  CompiledPlugin,
  CompiledRequest,
  CompiledSink,
  CompiledSource,
  CompiledTargetRequest,
  CompiledTargetSink,
  CompiledWebhook,
} from './compile.js'
export { ConnectorError, PluginValidationError, type ErrorKind } from './errors.js'
export type { Binding, CachedToken, HostPorts, HttpRequest, HttpResponse, Row, TargetHttpRequest, WebhookRequest } from './ports.js'
export { handleWebhook, type WebhookResult } from './webhook.js'
export { runSource, type RunOptions, type SourceResult } from './source.js'
export { orderSinks, runSink, runSinks, sinksFor, type Change, type PlannedBatch, type SinkResult } from './sink.js'
export { ExpressionError } from '../cel/index.js'
