# Changelog

## 0.2.0

Plugins can read and write through the host's own API (the target) instead of a domain pack. 0.1 plugins run unchanged.

- Target mode: sinks `read` their rows from the target API (`key`, `fields`, `where`, paging); sources `call` it per record. New optional `target` port.
- Sinks: `skip` (echo guard), `on_delete: send` with `deleted` changes, `after` ordering, `on` events; `orderSinks`, `sinksFor`, `runSinks`.
- Plugin-level `headers`; `domain` is optional; source-level `when`.
- CEL: `now`, `dateIn`, `addDays`, `upper`, `replaceAll`, `currencyDigits`.
- A sink now forgets rows that are gone, so they are sent again if they come back. `saveRemote` takes `null` to remove a key.
- A missing required secret fails the run as `config`.
- PriceLabs plugin (`src/plugins/pricelabs.ts`).

## 0.1.0

First release, as a single package with subpath imports.

- Plugin and domain-pack format with JSON Schemas (`connector-hub`, `connector-hub/schema/*`).
- Restricted CEL with parse limits, field analysis and money/date helpers (`connector-hub/cel`).
- Compiler, source runner (paging, incremental cursors committed with operations) and sink runner (plan/apply against a last-written snapshot), with auth presets and typed errors (`connector-hub`).
- In-memory host and HTTP fixture replay (`connector-hub/testkit`).
- Domain packs for short-term rentals (`connector-hub/str`) and contacts (`connector-hub/contacts`).
