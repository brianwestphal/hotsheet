// HS-8714 — cross-platform replacement for the old `build:client` npm script,
// which used Unix-only shell (`mkdir -p`, `cp`, `cat`, `${VAR:-default}`) and
// so failed under cmd.exe on Windows. This does the same four steps with Node
// + the esbuild / sass JS APIs (no shell builtins), producing byte-identical
// output on macOS/Linux. Honors PLUGINS_ENABLED from the environment.
import { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';
import * as sass from 'sass';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const clientDist = join(root, 'dist', 'client');
const pluginsEnabled = process.env.PLUGINS_ENABLED ?? 'true';

// 1. Copy static assets into dist/client/assets/.
mkdirSync(join(clientDist, 'assets'), { recursive: true });
cpSync(join(root, 'src', 'client', 'assets'), join(clientDist, 'assets'), { recursive: true });

// 2. Bundle the client JS (IIFE, minified-ish, es2020) via the esbuild API —
//    the JS-API options below mirror the old CLI flags 1:1.
await esbuild.build({
  entryPoints: [join(root, 'src', 'client', 'app.tsx')],
  bundle: true,
  format: 'iife',
  outfile: join(clientDist, 'app.global.js'),
  target: 'es2020',
  jsx: 'automatic',
  jsxImportSource: '#jsx',
  alias: { '#jsx/jsx-runtime': join(root, 'src', 'jsx-runtime.ts') },
  // `__PLUGINS_ENABLED__` is replaced with the raw token `true`/`false`
  // (a JS boolean literal), exactly like `--define:__PLUGINS_ENABLED__=true`.
  define: { __PLUGINS_ENABLED__: pluginsEnabled },
  sourcemap: true,
});

// 3. Compile SCSS → compressed CSS (no sourcemap), then 4. append xterm's CSS.
const compiled = sass.compile(join(root, 'src', 'client', 'styles.scss'), { style: 'compressed' });
const stylesOut = join(clientDist, 'styles.css');
writeFileSync(stylesOut, compiled.css);
appendFileSync(stylesOut, readFileSync(join(root, 'node_modules', '@xterm', 'xterm', 'css', 'xterm.css'), 'utf8'));

console.log('build:client done');
