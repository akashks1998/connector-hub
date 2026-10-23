# @connector-hub/domain-contacts

Contacts domain pack for connector-hub.

| Entity | Key |
| --- | --- |
| `person` | `external_id` |
| `organisation` | `external_id` |

Operations: `upsert_person`, `delete_person`, `upsert_organisation`.

```ts
import { contactsDomain } from '@connector-hub/domain-contacts'
const plugin = compilePlugin(declaration, contactsDomain)
```

See [Domain packs](https://github.com/akashks1998/connector-hub/blob/main/docs/domain-packs.md). Apache-2.0.
