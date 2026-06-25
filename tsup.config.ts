import { defineConfig } from 'tsup';
import { execSync } from 'child_process';
import { appendFileSync, cpSync, mkdirSync, readFileSync } from 'fs';

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
    // Bundle everything EXCEPT the packages that build-sidecar.sh ships
    // alongside cli.js under src-tauri/server/node_modules/ — they have to
    // be resolved at runtime:
    //   - @electric-sql/pglite needs filesystem access to its WASM.
    //   - hono / @hono/node-server are tsup's original external set.
    //   - node-pty is a CJS native addon that does `require('fs')`; if
    //     esbuild bundles it into an ESM output, those calls become
    //     `__require('fs')` and blow up with "Dynamic require of fs is
    //     not supported" at boot (HS-6734).
    //   - ws + @xterm/* travel with node-pty in the sidecar's node_modules
    //     (OPTIONAL_DEPS in build-sidecar.sh), so they also stay external.
    noExternal: [/^(?!@electric-sql|hono|@hono|node-pty|ws($|\/)|@xterm)/],
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
      // Shebang first. Then a real `require` in ESM scope: esbuild's generated
      // `__require` shim uses it when defined (`typeof require !== "undefined"`),
      // else throws "Dynamic require of X is not supported". node-forge does a
      // conditional `require('crypto')` esbuild can't statically convert to an
      // import, so without this the bundled cli.js crashes on boot (HS-9032).
      js: "#!/usr/bin/env node\nimport { createRequire as __hsCreateRequire } from 'module';\nconst require = __hsCreateRequire(import.meta.url);",
    },
  },
  // Channel server (MCP server for Claude Code integration)
  // Bundle everything including @modelcontextprotocol/sdk so it's mostly
  // self-contained — EXCEPT zod, which build-sidecar.sh ships under
  // src-tauri/server/node_modules/ and resolves at runtime.
  //
  // HS-8706 — zod MUST stay external. `@modelcontextprotocol/sdk@1.29.0`'s
  // `types.js` runs top-level `z.custom()` calls (its new Tasks-API schemas) at
  // module-load time. When zod is bundled, esbuild's lazy ESM module init runs
  // the SDK module body BEFORE zod's, so zod's `ZodCustom` class is still
  // undefined when `custom()` fires → `TypeError: Class2 is not a constructor`
  // → channel.js crashes on boot → the installed app's MCP server "won't
  // connect" because it can't even start. (`tsx` dev never hit this — Node's
  // real ESM loader initializes zod first.) Keeping zod external makes the
  // bundle resolve the real, fully-initialized zod module at runtime, matching
  // the dev order. Pinned by `src/channelBundle.test.ts`.
  {
    entry: ['src/channel.ts'],
    format: 'esm',
    outDir: 'dist',
    target: 'node20',
    platform: 'node',
    splitting: false,
    clean: false,
    sourcemap: false,
    noExternal: [/^(?!zod($|\/))/],
    external: ['zod'],
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
      // HS-6799: xterm.js ships a stylesheet that positions its internal layers
      // (`.xterm-helper-textarea`, `.xterm-viewport`, `.xterm-screen`) absolutely
      // and hides the IME helper textarea via `opacity: 0`. Without it the helper
      // `<textarea>` renders as a visible, user-resizable box inside the terminal
      // pane and xterm's canvas rows misalign — producing stray glyphs at the top
      // of the pane in Tauri production builds. Append it here so `tsup`-driven
      // builds (what `build-sidecar.sh` uses) match the dev path in `build:client`.
      const xtermCss = readFileSync('node_modules/@xterm/xterm/css/xterm.css', 'utf8');
      appendFileSync('dist/client/styles.css', xtermCss);
    },
  },
  // HS-9033 — standalone device-pairing page bundle (`/pair`). A SEPARATE entry
  // from app.tsx so the heavy `node-forge` dependency (in-browser keypair + CSR +
  // .p12) only loads on the pairing surface, not on every app page load. Same
  // browser/IIFE/minify settings as the app bundle; styles come from the shared
  // styles.css the app block compiles, so no onSuccess here.
  {
    entry: ['src/client/pair.tsx'],
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
