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
        lines: 95.03,
        functions: 87.12,
        branches: 87.86,
        statements: 93.06,
      },
    },
  },
});
