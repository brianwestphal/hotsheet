import { defineConfig } from 'tsup';
import { execSync } from 'child_process';
import { cpSync, mkdirSync } from 'fs';

export default defineConfig([
  // Server bundle (CLI entry point)
  {
    entry: ['src/cli.ts'],
    format: 'esm',
    outDir: 'dist',
    target: 'node20',
    platform: 'node',
    splitting: false,
    clean: true,
    sourcemap: true,
    noExternal: [/^(?!@electric-sql|hono|@hono)/],
    define: {
      'process.env.BUILD_TIMESTAMP': JSON.stringify(new Date().toISOString()),
    },
    esbuildOptions(options) {
      options.jsx = 'automatic';
      options.jsxImportSource = '#jsx';
      options.alias = {
        '#jsx/jsx-runtime': './src/jsx-runtime.ts',
      };
    },
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
  // Channel server (MCP server for Claude Code integration)
  // Bundle everything including @modelcontextprotocol/sdk so it's fully self-contained
  {
    entry: ['src/channel.ts'],
    format: 'esm',
    outDir: 'dist',
    target: 'node20',
    platform: 'node',
    splitting: false,
    clean: false,
    sourcemap: false,
    noExternal: [/.*/],
  },
  // Client bundle (browser JS + SCSS)
  {
    entry: ['src/client/app.tsx'],
    format: 'iife',
    outDir: 'dist/client',
    target: 'es2020',
    platform: 'browser',
    splitting: false,
    clean: false,
    sourcemap: false,
    minify: true,
    esbuildOptions(options) {
      options.jsx = 'automatic';
      options.jsxImportSource = '#jsx';
      options.alias = {
        '#jsx/jsx-runtime': './src/jsx-runtime.ts',
      };
    },
    onSuccess: async () => {
      mkdirSync('dist/client/assets', { recursive: true });
      cpSync('src/client/assets', 'dist/client/assets', { recursive: true });
      execSync('npx sass src/client/styles.scss dist/client/styles.css --style compressed --no-source-map', { stdio: 'inherit' });
    },
  },
]);
