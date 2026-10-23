# Changelog

## 0.1.0

First release.

- Plugin and domain-pack format with JSON Schemas (`@connector-hub/spec`).
- Restricted CEL with parse limits, field analysis and money/date helpers (`@connector-hub/cel`).
- Compiler, source runner (paging, incremental cursors committed with operations) and sink runner (plan/apply against a last-written snapshot), with auth presets and typed errors (`@connector-hub/core`).
- In-memory host and HTTP fixture replay (`@connector-hub/testkit`).
- Domain packs for short-term rentals and contacts.
