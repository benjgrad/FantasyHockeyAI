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
    coverage: {
      provider: 'v8',
      include: ['libs/model/src/**', 'libs/core/src/**'],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
});
