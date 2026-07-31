#!/usr/bin/env node
/**
 * HS-9531 — "what blocked the event loop, ranked, over window W".
 *
 *   npm run analyze:freeze                 # the whole log
 *   npm run analyze:freeze -- --hours 2    # the last 2 hours
 *   npm run analyze:freeze -- --file <p>   # a log pasted from elsewhere
 *
 * Deliberately a THIN wrapper: every judgment lives in
 * `src/diagnostics/freezeAnalysis.ts`, which is unit-tested. This file only
 * resolves a path, slices a window, and prints. The HS-9521 investigation
 * re-derived this logic three times in throwaway JS and got it wrong twice — the
 * point of the module is that nobody has to write it a fourth time under
 * pressure while a server is down.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { formatReport, parseFreezeLog } from '../dist/diagnostics/freezeAnalysis.js';

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? null : args[i + 1] ?? null;
};

const globalDir = process.env.HOTSHEET_HOME ?? join(homedir(), '.hotsheet');
const file = flag('file') ?? join(globalDir, 'diagnostics', 'freeze.log');

let raw;
try {
  raw = readFileSync(file, 'utf8');
} catch (err) {
  console.error(`Could not read ${file}: ${err.message}`);
  console.error('Pass --file <path>, or set HOTSHEET_HOME if the instance is relocated.');
  process.exit(1);
}

const entries = parseFreezeLog(raw);
if (entries.length === 0) {
  console.error(`No parseable entries in ${file}.`);
  process.exit(1);
}

const hours = flag('hours');
let window = null;
if (hours !== null) {
  // Anchored to the newest entry rather than "now": the interesting log is often
  // one pasted from a machine that has since been restarted, where wall-clock now
  // is hours past anything in the file.
  const newest = Math.max(...entries.map((e) => Date.parse(e.ts)));
  window = { fromMs: newest - Number(hours) * 3_600_000, toMs: newest };
}

console.log(`source: ${file}`);
console.log(formatReport(entries, window));
