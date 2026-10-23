# @connector-hub/domain-str

Short-term rental domain pack for connector-hub.

| Entity | Key | |
| --- | --- | --- |
| `listing` | `external_id` | a rentable unit |
| `calendar_day` | `listing_id`, `date` | availability, price and stay rules for one night |
| `booking` | `external_id` | a reservation |

Operations: `upsert_listing`, `upsert_calendar_day`, `patch_calendar_day`,
`upsert_booking`, `delete_booking`. Money is integer minor units
(`price_minor`, `total_minor`).

```ts
import { strDomain } from '@connector-hub/domain-str'
const plugin = compilePlugin(declaration, strDomain)
```

See [Domain packs](https://github.com/akashks1998/connector-hub/blob/main/docs/domain-packs.md). Apache-2.0.
