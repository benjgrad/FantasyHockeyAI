import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    // Tests import workspace libs from source, not dist. `validate` runs tests before `build`,
    // so resolving through dist would test a stale build of any lib changed in the same edit.
    alias: [
      {
        find: /^@fha\/([a-z]+)$/,
        replacement: fileURLToPath(new URL('./libs/$1/src/index.ts', import.meta.url)),
      },
    ],
  },
  test: {
    include: ['{libs,apps}/**/src/**/*.test.ts'],
    // CI's 2-core runner (and a busy gradyserver) can push a cold first call past vitest's 5 s
    // default: apps/mcp's first tools/call loads the mock snapshot. A real hang still fails.
    testTimeout: 15_000,
    coverage: {
      provider: 'v8',
      include: ['libs/model/src/**', 'libs/core/src/**'],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
});
