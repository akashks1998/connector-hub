import type { JsonValue } from '../spec/index.js'
import type { CompiledPlugin } from './compile.js'
import { ConnectorError } from './errors.js'
import type { Binding } from './ports.js'

/**
 * The binding as the plugin may see it: only its declared non-secret config,
 * type-checked. Undeclared values never reach an expression.
 */
export function bindingFor(plugin: CompiledPlugin, binding: Binding): Binding {
  const config: Record<string, JsonValue> = {}
  for (const [name, field] of Object.entries(plugin.declaration.config)) {
    if (field.secret) continue
    const value = binding.config[name]
    if (value === undefined || value === null || value === '') {
      if (field.required) throw new ConnectorError('config', `binding ${binding.id}: config.${name} is required`)
      config[name] = null
      continue
    }
    const ok =
      (field.type === 'string' && typeof value === 'string') ||
      (field.type === 'int' && typeof value === 'number' && Number.isSafeInteger(value)) ||
      (field.type === 'bool' && typeof value === 'boolean')
    if (!ok) throw new ConnectorError('config', `binding ${binding.id}: config.${name} must be a ${field.type}`)
    config[name] = value
  }
  return { id: binding.id, config }
}
