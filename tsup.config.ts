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
      '__PLUGINS_ENABLED__': process.env.PLUGINS_ENABLED === 'false' ? 'false' : 'true',
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
    define: {
      '__PLUGINS_ENABLED__': process.env.PLUGINS_ENABLED === 'false' ? 'false' : 'true',
    },
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
  // Bundled plugins
  {
    entry: ['plugins/github-issues/src/index.ts'],
    format: 'esm',
    outDir: 'dist/plugins/github-issues',
    target: 'node20',
    platform: 'node',
    splitting: false,
    clean: false,
    sourcemap: false,
    onSuccess: async () => {
      mkdirSync('dist/plugins/github-issues', { recursive: true });
      cpSync('plugins/github-issues/manifest.json', 'dist/plugins/github-issues/manifest.json');
    },
  },
  // Demo plugin is NOT bundled for production — it's only built locally via `npm run build:plugins`.
  // Only the GitHub Issues plugin ships with the app.
]);
