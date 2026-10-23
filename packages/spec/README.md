# @connector-hub/spec

The declaration format for connector-hub: zod schemas and TypeScript types
for plugins and domain packs, the `Operation` type, and the engine contract
version.

```ts
import { Plugin, DomainPack, ENGINE_CONTRACT, type Operation } from '@connector-hub/spec'
```

JSON Schemas for editors ship in `schema/`:

```yaml
# yaml-language-server: $schema=https://unpkg.com/@connector-hub/spec/schema/plugin.schema.json
```

See the [plugin reference](https://github.com/akashks1998/connector-hub/blob/main/docs/plugin-reference.md) and
[domain packs](https://github.com/akashks1998/connector-hub/blob/main/docs/domain-packs.md).

Apache-2.0. Part of [connector-hub](https://github.com/akashks1998/connector-hub).
