# Contributing

Thanks for your interest. connector-hub is in early development, so please open
an issue to discuss a change before sending a large pull request.

## Setup

```sh
pnpm install
pnpm test
pnpm build
```

## Guidelines

- Keep the engine (`src/core`) free of I/O. Anything with side effects belongs
  behind `HostPorts`.
- New plugin capabilities are new, reviewed engine building blocks. Plugins
  never get an escape hatch into arbitrary code.
- Every behaviour change needs a test. Use `connector-hub/testkit` fixtures,
  never live provider calls.
- Never commit real credentials or unscrubbed provider responses.

## Releases

Packages follow semver. Until 1.0, a minor version may break the plugin
contract; `ENGINE_CONTRACT` in `connector-hub` records the version a
release implements.
