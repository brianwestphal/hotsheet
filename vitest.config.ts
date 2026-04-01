import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    pool: 'forks',
    testTimeout: 30000,
    exclude: ['e2e/**', 'node_modules/**'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json'],
      reportsDirectory: './coverage',
      all: true,
      include: ['src/**/*.{ts,tsx}'],
      exclude: [
        'src/**/*.test.{ts,tsx}',
        'src/test-helpers.ts',
        'src/types.ts',
      ],
    },
  },
});
