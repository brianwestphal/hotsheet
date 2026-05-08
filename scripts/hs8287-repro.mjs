#!/usr/bin/env node
// HS-8287 — manual repro for the "duplication after resize" symptom.
//
// Run this in a Hot Sheet terminal. It prints ~200 lines of vibrantly-coloured,
// uniquely-numbered content (no chalk dep — raw ANSI escapes, same convention
// as scripts/simulate-claude-prompts.mjs), then idles so the PTY stays alive.
//
// What to do once it finishes printing:
//   1. Scroll up through the buffer — every `#001`..`#200` should appear exactly
//      once. Adjacent lines have different colours so duplicates pop visually.
//   2. Drag the drawer (or dashboard tile) splitter several times — smaller,
//      larger, narrow, wide, repeat. The same range your video showed.
//   3. Scroll up again and look for any `#NNN` token that appears twice.
//
// The script is plain `echo`-style output: NO SIGWINCH redraw, NO clear+home,
// NO cursor positioning, NO alternate buffer. If you see a duplicate `#NNN`,
// the duplication is happening in xterm.js or in our pipeline — not in any TUI
// re-emit. (The unit test in src/client/terminalCheckout.test.ts already proves
// the resize → term.resize → reflow path itself doesn't duplicate; this script
// gives us a real-app stress check on top of that.)
//
// Usage:
//   node scripts/hs8287-repro.mjs           # default: 200 lines
//   node scripts/hs8287-repro.mjs 500       # 500 lines (more scrollback)
//   node scripts/hs8287-repro.mjs 200 fast  # no per-line delay
//
// Defaults to a tiny per-line delay so the PTY chunks reach the client over
// many WebSocket frames (closer to how Claude Code emits its UI). Pass `fast`
// to dump everything at once.

const argCount = parseInt(process.argv[2] ?? '200', 10);
const COUNT = Number.isFinite(argCount) && argCount > 0 ? argCount : 200;
const FAST = process.argv[3] === 'fast';

// ANSI colour palette — bright + distinct + cycle so adjacent lines never
// share the same hue. Order chosen so neighbours have high colour contrast.
const PALETTE = [
  '\x1b[38;5;196m', // bright red
  '\x1b[38;5;46m',  // bright green
  '\x1b[38;5;33m',  // bright blue
  '\x1b[38;5;226m', // yellow
  '\x1b[38;5;201m', // magenta
  '\x1b[38;5;51m',  // cyan
  '\x1b[38;5;208m', // orange
  '\x1b[38;5;129m', // purple
];
const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const INVERSE = '\x1b[7m';

// Word salad so every line is visually unique — easier to spot a true byte-
// for-byte duplicate than a "looks similar" near-miss. Picked nouns + verbs
// of varying lengths to force different wrap points at narrow widths.
const NOUNS = [
  'kerf', 'lathe', 'chisel', 'awl', 'mortise', 'tenon', 'dovetail', 'plane',
  'router', 'jointer', 'sander', 'clamp', 'rasp', 'gouge', 'mallet', 'bevel',
  'spline', 'rabbet', 'dado', 'fillet', 'chamfer', 'fence', 'jig', 'dowel',
];
const VERBS = [
  'cuts', 'shapes', 'joins', 'planes', 'sands', 'fits', 'aligns', 'measures',
  'glues', 'clamps', 'reams', 'bores', 'mills', 'turns', 'finishes', 'oils',
];

function pick(arr, i) { return arr[i % arr.length]; }

function header() {
  process.stdout.write(`${BOLD}${INVERSE} HS-8287 repro — printing ${COUNT} unique colour-coded lines ${RESET}\n`);
  process.stdout.write(`${DIM}Resize the drawer / tile after printing finishes. Scroll up and look for any duplicate #NNN.${RESET}\n`);
  process.stdout.write(`${DIM}─────────────────────────────────────────────────────────────────────────────────────────${RESET}\n`);
}

function line(n) {
  const num = String(n).padStart(4, '0');
  const colour = PALETTE[n % PALETTE.length];
  // Each line carries: ID, two random-ish words, a hex-like nonce derived
  // from `n` so it's deterministic but unique. Length varies (45–95 chars)
  // so reflow at narrow widths exercises different wrap points per line.
  const noun = pick(NOUNS, n * 7);
  const verb = pick(VERBS, n * 13);
  const noun2 = pick(NOUNS, n * 17 + 3);
  const nonce = (n * 2654435761 >>> 0).toString(16).padStart(8, '0');
  const padCount = 5 + (n % 50); // 5..54 trailing chars to vary wrap point
  const tail = '═'.repeat(padCount);
  return `${colour}#${num}${RESET} ${BOLD}${colour}${noun}${RESET} ${verb} ${colour}${noun2}${RESET} ${DIM}[${nonce}]${RESET} ${colour}${tail}${RESET}`;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function main() {
  header();
  for (let i = 1; i <= COUNT; i++) {
    process.stdout.write(line(i) + '\n');
    if (!FAST && i % 10 === 0) await sleep(15); // ~3s total at 200 lines
  }
  process.stdout.write(`${DIM}─────────────────────────────────────────────────────────────────────────────────────────${RESET}\n`);
  process.stdout.write(`${BOLD}${INVERSE} done — printed ${COUNT} lines. Now resize the drawer and scroll up. ${RESET}\n`);
  process.stdout.write(`${DIM}Ctrl-C to exit.${RESET}\n`);

  // Keep the PTY alive so the WS stays connected during your resize cycles.
  // Without this the shell exits right after the last write and `attach`'s
  // `noSession` path kicks in on the next render.
  await new Promise(() => { /* never resolves; Ctrl-C exits */ });
}

main().catch(err => { console.error(err); process.exit(1); });
