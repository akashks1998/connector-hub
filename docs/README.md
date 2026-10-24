# connector-hub documentation

connector-hub runs connector plugins that are declarations, not code. Start
with **Getting started**, then use the reference pages as you write plugins.

| Page | For |
| --- | --- |
| [Getting started](getting-started.md) | Install, write a first plugin, run it against a live API |
| [Concepts](concepts.md) | Domain packs, plugins, bindings, host ports, operations |
| [Plugin reference](plugin-reference.md) | Every field of a plugin file, with defaults |
| [Expressions](expressions.md) | CEL in plugins: variables, numbers, helpers, limits |
| [Sources](sources.md) | Reading from a provider: paging, mapping, cursors |
| [Sinks](sinks.md) | Writing to a provider: declared input, plan and apply |
| [Authentication](auth.md) | Auth presets, secrets and token caching |
| [Domain packs](domain-packs.md) | Defining entities and operations for a domain |
| [Integrating a host](host-integration.md) | Implementing `HostPorts` in your application |
| [Errors](errors.md) | Error kinds and what a host should do with each |
| [Testing plugins](testing.md) | Fixture replay, the in-memory host, live runs |
| [Design notes](design.md) | Why the engine is shaped this way |

Editors can validate plugin files with the JSON Schema shipped in
`connector-hub/schema/plugin.schema.json`. In a YAML file, add:

```yaml
# yaml-language-server: $schema=https://unpkg.com/connector-hub/schema/plugin.schema.json
```
