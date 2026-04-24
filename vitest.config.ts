import { defineConfig } from 'vitest/config';

export default defineConfig({
  // HS-7331 — alias both `#jsx/jsx-runtime` and `#jsx/jsx-dev-runtime` to the
  // project's custom JSX runtime so vitest can compile .tsx files. The build
  // pipeline (esbuild) only needs the non-dev alias; vitest's dev-mode
  // transform imports `-dev-runtime` and fails without this mapping.
  resolve: {
    alias: {
      '#jsx/jsx-runtime': '/src/jsx-runtime.ts',
      '#jsx/jsx-dev-runtime': '/src/jsx-runtime.ts',
    },
  },
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
