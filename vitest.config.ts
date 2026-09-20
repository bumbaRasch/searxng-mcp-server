import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src'],
      reporter: ['text', 'html'],
      thresholds: {
        autoUpdate: true,
        lines: 95.87,
        functions: 90.27,
        branches: 87.97,
        statements: 93.86,
      },
    },
  },
});
