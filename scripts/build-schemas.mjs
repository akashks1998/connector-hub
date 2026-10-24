// Writes JSON Schemas for plugin and domain-pack files, for editor validation.
import { mkdirSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { DomainPack, Plugin } from '../dist/spec/index.js'

const out = new URL('../schema/', import.meta.url)
mkdirSync(out, { recursive: true })
const write = (name, schema, title) => {
  const json = { ...z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }), $id: `https://unpkg.com/connector-hub/schema/${name}`, title }
  writeFileSync(new URL(name, out), `${JSON.stringify(json, null, 2)}\n`)
}
write('plugin.schema.json', Plugin, 'connector-hub plugin')
write('domain.schema.json', DomainPack, 'connector-hub domain pack')
console.log('schemas written')
