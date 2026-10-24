# Changelog

## 0.2.0

Plugins can read and write through the host's own API (the target) instead of a domain pack. 0.1 plugins run unchanged.

- Target mode: sinks `read` their rows from the target API (`key`, `fields`, `where`, paging); sources `call` it per record. New optional `target` port.
- Sinks: `skip` (echo guard), `on_delete: send` with `deleted` changes, `after` ordering, `on` events; `orderSinks`, `sinksFor`, `runSinks`.
- Plugin-level `headers`; `domain` is optional; source-level `when`.
- CEL: `now`, `dateIn`, `addDays`, `daysBetween`, `upper`, `replaceAll`, `currencyDigits`, `compact`, `fromEntries`.
- Sinks save the whole row and compare only `fields`, so deletions can use any field.
- The snapshot records the binding config under the key `#config`; changing the config sends every row again. Target-mode sinks forget rows that are gone (`saveRemote` gets `null` for them); domain-mode sinks keep 0.1 behaviour.
- Target paths are checked after rendering (no `//`, encoded `..`, backslash, `#`); target calls get the plugin's timeout and body limits.
- A `call` source refuses to send when a page or record cap cut the read short.
- A missing required secret fails the run as `config`.
- Webhooks: `handleWebhook` with `ping`, `binding`, `verify`, `when`, `dedupe_key`, `order`, and one action of `call`, `reread`, `resend`, `issue`. New optional `webhooks` port.
- CEL: `hmacSha256Hex`, `secureEquals`, `base64`, `uuidFrom`.
- OAuth `not_before_ms`: wait before using a new token.
- PriceLabs plugin (`src/plugins/pricelabs.ts`), with the `sync`, `calendar` and `hook` webhooks.
- Sink `precheck`: read the provider's records per batch; changes `allow` refuses come back in `SinkResult.conflicts`, unsent and unsaved.
- Hostaway plugin (`src/plugins/hostaway.ts`): reservations and closed nights in (poll and webhook), Propool's closed nights out with a note marker, guarded by a precheck.

## 0.1.0

First release, as a single package with subpath imports.

- Plugin and domain-pack format with JSON Schemas (`connector-hub`, `connector-hub/schema/*`).
- Restricted CEL with parse limits, field analysis and money/date helpers (`connector-hub/cel`).
- Compiler, source runner (paging, incremental cursors committed with operations) and sink runner (plan/apply against a last-written snapshot), with auth presets and typed errors (`connector-hub`).
- In-memory host and HTTP fixture replay (`connector-hub/testkit`).
- Domain packs for short-term rentals (`connector-hub/str`) and contacts (`connector-hub/contacts`).
