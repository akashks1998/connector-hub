# @connector-hub/core

The connector-hub engine: compiles declarative connector plugins and runs
their sources and sinks. It performs no I/O; your application supplies
`HostPorts`.

```sh
npm install @connector-hub/core
```

```ts
import { compilePlugin, runSink, runSource, ConnectorError } from '@connector-hub/core'

const plugin = compilePlugin(declaration, domainPack)   // throws PluginValidationError listing every problem
const read = await runSource(plugin, binding, 'reservations', hostPorts)
const { plan } = await runSink(plugin, binding, 'availability', hostPorts, { dryRun: true })
```

- [Getting started](https://github.com/akashks1998/connector-hub/blob/main/docs/getting-started.md)
- [Plugin reference](https://github.com/akashks1998/connector-hub/blob/main/docs/plugin-reference.md)
- [Integrating a host](https://github.com/akashks1998/connector-hub/blob/main/docs/host-integration.md)
- [Errors](https://github.com/akashks1998/connector-hub/blob/main/docs/errors.md)

Apache-2.0. Part of [connector-hub](https://github.com/akashks1998/connector-hub).
