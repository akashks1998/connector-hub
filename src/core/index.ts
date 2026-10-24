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
} from './compile.js'
export { ConnectorError, PluginValidationError, type ErrorKind } from './errors.js'
export type { Binding, CachedToken, HostPorts, HttpRequest, HttpResponse, Row, TargetHttpRequest } from './ports.js'
export { runSource, type RunOptions, type SourceResult } from './source.js'
export { orderSinks, runSink, runSinks, sinksFor, type Change, type PlannedBatch, type SinkResult } from './sink.js'
export { ExpressionError } from '../cel/index.js'
