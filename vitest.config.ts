import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{libs,apps}/**/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['libs/model/src/**', 'libs/core/src/**'],
      thresholds: { lines: 90, functions: 90, branches: 80, statements: 90 },
    },
  },
});
