# Changelog

## 0.1.0

First release, as a single package with subpath imports.

- Plugin and domain-pack format with JSON Schemas (`connector-hub`, `connector-hub/schema/*`).
- Restricted CEL with parse limits, field analysis and money/date helpers (`connector-hub/cel`).
- Compiler, source runner (paging, incremental cursors committed with operations) and sink runner (plan/apply against a last-written snapshot), with auth presets and typed errors (`connector-hub`).
- In-memory host and HTTP fixture replay (`connector-hub/testkit`).
- Domain packs for short-term rentals (`connector-hub/str`) and contacts (`connector-hub/contacts`).
