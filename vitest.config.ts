import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src'],
      // The bin entrypoint wires transports to process-level concerns (argv,
      // env, signal handlers, process.exit) — exercised by scripts/e2e.mjs
      // and the http smoke checks instead of in-process unit tests.
      exclude: ['src/index.ts'],
      reporter: ['text', 'html'],
      thresholds: {
        autoUpdate: false,
        lines: 99.2,
        functions: 94.37,
        branches: 89.16,
        statements: 96.95,
      },
    },
  },
});
