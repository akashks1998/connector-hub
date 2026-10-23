import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

const src = (dir: string) => fileURLToPath(new URL(`./${dir}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    alias: {
      '@connector-hub/spec': src('packages/spec'),
      '@connector-hub/cel': src('packages/cel'),
      '@connector-hub/core': src('packages/core'),
      '@connector-hub/testkit': src('packages/testkit'),
      '@connector-hub/domain-str': src('domains/str'),
      '@connector-hub/domain-contacts': src('domains/contacts'),
    },
  },
  test: { include: ['packages/*/src/**/*.test.ts', 'domains/*/src/**/*.test.ts'] },
})
