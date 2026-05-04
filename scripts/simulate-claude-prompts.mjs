#!/usr/bin/env node
// HS-8196 — emit Claude-Code-style permission / choice prompts on stdout so
// the §52 terminal-prompt overlay can be exercised without launching real
// `claude`. Runs as a plain Node ESM script (no transpile, no extra deps).
//
// Two emit modes — the user-facing testing path is the same; the script
// picks the right path from the `<type>` arg.
//
// 1) **Terminal mode** (§52 overlay) — prints a Claude-Code-style prompt to
//    stdout so the server-side `promptScanner` parses it from PTY output.
//    Shapes follow the parsers in src/shared/terminalPrompt/parsers.ts:
//    - claude-numbered:  `> 1. Foo / 2. Bar / Enter to confirm · Esc to cancel`
//    - yesno:            `[y/n]` / `[Y/n]` / `(y/N)` / `[yes/no]`
//    - generic:          any line ending in `?`
//
// 2) **Permission-popup mode** (§47 channel-server popup, including the
//    HS-8171 v2 live-terminal-borrow path when input_preview is truncated) —
//    POSTs to the channel server's debug `/permission/inject` endpoint
//    (HS-8205) instead of emitting to stdout. Triggered by `permission-*`
//    types. Reads `<dataDir>/channel-port` to find the running server.
//
// Usage:
//   node scripts/simulate-claude-prompts.mjs <type> [--delay N] [--no-color]
//                                                   [--data-dir <path>]
//   node scripts/simulate-claude-prompts.mjs --list
//
// In terminal mode the script reads stdin and exits when the user (or the
// §52 overlay) sends a response. In permission mode the script POSTs the
// payload, prints the request id, and exits — dismiss the popup via the UI.

import { stdin, stdout, exit, argv, env } from 'node:process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// ANSI helpers — raw codes, no chalk dependency.
// ---------------------------------------------------------------------------

const NO_COLOR = env.NO_COLOR === '1' || argv.includes('--no-color');
const wrap = (open, close) => (s) => NO_COLOR ? s : `\x1b[${open}m${s}\x1b[${close}m`;
const c = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  magenta: wrap(35, 39),
  cyan: wrap(36, 39),
  gray: wrap(90, 39),
  bgRed: wrap(41, 49),
  bgYellow: wrap(43, 49),
};

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

const NUMBERED_FOOTER = 'Enter to confirm · Esc to cancel';
const DIVIDER = '─'.repeat(60);

function emitNumbered(question, options, { highlightedIdx = 0, contextLines = [] } = {}) {
  if (contextLines.length > 0) {
    for (const line of contextLines) stdout.write(line + '\n');
    stdout.write('\n');
  }
  stdout.write(c.bold(c.cyan(question)) + '\n');
  stdout.write('\n');
  options.forEach((label, i) => {
    const marker = i === highlightedIdx ? c.yellow('❯') : ' ';
    const num = i === highlightedIdx ? c.bold(c.yellow(`${i + 1}.`)) : c.gray(`${i + 1}.`);
    const text = i === highlightedIdx ? c.bold(label) : label;
    stdout.write(`${marker} ${num} ${text}\n`);
  });
  stdout.write('\n');
  stdout.write(c.dim(NUMBERED_FOOTER) + '\n');
}

function emitYesNo(question, marker) {
  stdout.write(c.bold(c.cyan(question)) + ' ' + c.yellow(marker) + ' ');
}

function emitGeneric(question, contextLines = []) {
  for (const line of contextLines) stdout.write(line + '\n');
  if (contextLines.length > 0) stdout.write('\n');
  stdout.write(c.bold(c.cyan(question)) + ' ');
}

// ---------------------------------------------------------------------------
// Catalog of types
// ---------------------------------------------------------------------------

const TYPES = {
  'numbered-2': {
    description: '2-option Claude numbered prompt (security warning)',
    emit: () =>
      emitNumbered(
        'Loading development channels can pose a security risk',
        ['I am using this for local development', 'Exit'],
        {
          contextLines: [
            c.red(c.bold('⚠  Security warning')),
            c.gray('This terminal is about to load development channels which may'),
            c.gray('expose unreleased features and bypass production safety checks.'),
          ],
        },
      ),
  },
  'numbered-5': {
    description: '5-option Claude numbered prompt with mid-length labels',
    emit: () =>
      emitNumbered(
        'How would you like to proceed with the failing test?',
        [
          'Re-run the test once and continue',
          'Re-run with verbose output',
          'Skip this test for now',
          'Open the failing assertion in the editor',
          'Abort the entire run',
        ],
        { highlightedIdx: 0 },
      ),
  },
  'numbered-diff': {
    description: 'Numbered prompt with edit-diff context (Edit-tool style)',
    emit: () =>
      emitNumbered(
        'Apply this edit to src/example.ts?',
        ['Yes, apply the edit', 'No, leave the file unchanged', 'Show me alternatives'],
        {
          highlightedIdx: 0,
          contextLines: [
            c.gray(DIVIDER),
            c.cyan('  src/example.ts'),
            c.gray(DIVIDER),
            c.red('-  return parseInput(raw);'),
            c.green('+  if (raw === null) return null;'),
            c.green('+  return parseInput(raw.trim());'),
            c.gray(DIVIDER),
          ],
        },
      ),
  },
  'numbered-long': {
    description: 'Numbered prompt with a LONG multi-paragraph warning header',
    emit: () =>
      emitNumbered(
        'Claude wants to run a long-running build command — proceed?',
        ['Allow this once', 'Always allow for this project', 'Cancel'],
        {
          highlightedIdx: 1,
          contextLines: [
            c.bgYellow(c.bold('  COMMAND PREVIEW  ')),
            '',
            c.cyan('  $ npm run build:everything'),
            '',
            c.gray('This will rebuild every workspace package and run the full'),
            c.gray('test matrix across Node 18 / 20 / 22 plus the Tauri sidecar.'),
            c.gray('Estimated duration: 8–12 minutes. Network access required for'),
            c.gray('package downloads. Disk usage may temporarily exceed 4 GB.'),
            '',
            c.dim('Affected packages:'),
            c.dim('  - @hotsheet/core'),
            c.dim('  - @hotsheet/client'),
            c.dim('  - @hotsheet/plugins/github-issues'),
            c.dim('  - @hotsheet/plugins/demo-plugin'),
            c.dim('  - @hotsheet/tauri-sidecar'),
          ],
        },
      ),
  },
  'numbered-bash': {
    description: 'Numbered prompt previewing a Bash command',
    emit: () =>
      emitNumbered(
        'Run this Bash command?',
        ['Allow once', 'Always allow this exact command', 'Deny'],
        {
          highlightedIdx: 0,
          contextLines: [
            c.gray(DIVIDER),
            c.bold(c.green('$ ') + 'find . -name "*.tmp" -mtime +7 -exec rm -v {} \\;'),
            c.gray(DIVIDER),
            c.dim('Working directory: ') + c.cyan('~/Documents/hotsheet'),
          ],
        },
      ),
  },

  'yesno-lower': {
    description: 'Lowercase yes/no — `[y/n]`',
    emit: () => emitYesNo('Continue with the migration?', '[y/n]'),
  },
  'yesno-yes-default': {
    description: 'Yes-default — `[Y/n]`',
    emit: () => emitYesNo('Save changes before exiting?', '[Y/n]'),
  },
  'yesno-no-default': {
    description: 'No-default — `[y/N]`',
    emit: () => emitYesNo('Force-delete this branch?', '[y/N]'),
  },
  'yesno-words': {
    description: 'Spelled-out — `[yes/no]`',
    emit: () => emitYesNo('Are you sure you want to overwrite the existing config?', '[yes/no]'),
  },
  'yesno-paren': {
    description: 'Parenthesised — `(y/N)`',
    emit: () => emitYesNo('Reset the database to a fresh state?', '(y/N)'),
  },

  'generic-short': {
    description: 'Plain question ending in `?`',
    emit: () => emitGeneric('What name should I use for the new branch?'),
  },
  'generic-context': {
    description: 'Generic prompt with multi-line context above the question',
    emit: () =>
      emitGeneric('Which option do you prefer?', [
        c.bold('Three approaches found:'),
        '',
        c.gray('  1. Rewrite the affected helper from scratch'),
        c.gray('  2. Patch the helper in place with a minimal fix'),
        c.gray('  3. Bypass the helper entirely from the call site'),
        '',
        c.dim('Type your preference below.'),
      ]),
  },

  // -------------------------------------------------------------------------
  // §47 permission-popup mode (HS-8205) — POST to the channel server's
  // /permission/inject debug endpoint instead of emitting to stdout. Long
  // payloads with deliberately-truncated JSON trigger the HS-8171 v2 live-
  // terminal-borrow path in permissionOverlay.tsx (`flatTruncated || diffTruncated`).
  // -------------------------------------------------------------------------

  'permission-bash-short': {
    description: 'Bash permission popup — short command, no terminal-borrow',
    permission: {
      tool_name: 'Bash',
      description: 'Run: ls -la',
      input_preview: JSON.stringify({ command: 'ls -la' }),
    },
  },
  'permission-bash-long': {
    description: 'Bash permission popup — long truncated command (borrows live terminal)',
    permission: {
      tool_name: 'Bash',
      description: 'Run a long pipeline',
      // Truncated mid-string: no closing `"` or `}`. Triggers
      // `formatInputPreview`'s forgiving-extractor path → `value + '…'` →
      // `flatTruncated === true` in permissionOverlay.tsx. The shell command
      // uses single quotes throughout so we don't have to escape `"` inside
      // the JSON value (an unescaped `"` would close the field early).
      input_preview: '{"command":"' + (
        'find / -name \'*.log\' -mtime -1 -size +1M -not -path \'/proc/*\' -not -path \'/sys/*\' '
        + '| xargs -I {} sh -c \'echo === {} ===; tail -200 {}; echo\' '
        + '| awk \'/ERROR/{print FILENAME \\": \\" $0}\' '
      ).repeat(8),
    },
  },
  'permission-edit-short': {
    description: 'Edit permission popup — short diff, no terminal-borrow',
    permission: {
      tool_name: 'Edit',
      description: 'Edit src/example.ts',
      input_preview: JSON.stringify({
        file_path: '/Users/me/project/src/example.ts',
        old_string: 'return parseInput(raw);',
        new_string: 'if (raw === null) return null;\nreturn parseInput(raw.trim());',
      }),
    },
  },
  'permission-edit-long': {
    description: 'Edit permission popup — long truncated diff (borrows live terminal)',
    permission: {
      tool_name: 'Edit',
      description: 'Refactor a large helper',
      // Truncated mid-`new_string` (no closing quote / brace). Triggers
      // `formatEditDiff`'s forgiving-extractor path → `truncated: true` →
      // `diffTruncated === true` in permissionOverlay.tsx.
      input_preview: '{"file_path":"/Users/me/project/src/very-long-renderer.tsx","old_string":"' + (
        'export function Renderer({ data }) {\\n'
        + '  return data.map(row => <Row key={row.id} data={row} />);\\n'
        + '}'
      ) + '","new_string":"' + (
        'export function Renderer({ data, columns, sort, filter, onSelect, onHover }: RendererProps) {\\n'
        + '  const sorted = useMemo(() => [...data].sort((a, b) => sort.direction === \\"asc\\" ? a[sort.column] - b[sort.column] : b[sort.column] - a[sort.column]), [data, sort]);\\n'
        + '  const filtered = useMemo(() => sorted.filter(row => filter.every(f => f.predicate(row))), [sorted, filter]);\\n'
      ).repeat(6),
    },
  },
  'permission-write-long': {
    description: 'Write permission popup — long truncated content (borrows live terminal)',
    permission: {
      tool_name: 'Write',
      description: 'Write a new file',
      // Truncated mid-`content`. Triggers Write's `formatEditDiff` branch
      // (line 126 of permissionPreview.ts) which falls back to extracting
      // the `content` field as `new_string`.
      input_preview: '{"file_path":"/Users/me/project/src/generated.ts","content":"' + (
        '// Auto-generated — do not edit.\\nexport const tableSchema = {\\n'
        + '  id: { type: \\"text\\", primary: true },\\n'
        + '  name: { type: \\"text\\", required: true },\\n'
        + '  created_at: { type: \\"timestamp\\", default: \\"now()\\" },\\n'
        + '};\\n'
      ).repeat(10),
    },
  },

  random: {
    description: 'Pick a type at random from the rest of the catalog',
    emit: () => {
      const candidates = Object.keys(TYPES).filter((k) => {
        if (k === 'random') return false;
        // Permission types depend on a running channel server; exclude them
        // from the random rotation so a no-channel local run doesn't fail.
        return TYPES[k].permission === undefined;
      });
      const pick = candidates[Math.floor(Math.random() * candidates.length)];
      stdout.write(c.dim(`(random pick: ${pick})\n\n`));
      TYPES[pick].emit();
    },
  },
};

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

function parseArgs(args) {
  const opts = { delay: 0, list: false, help: false, type: null, dataDir: '.hotsheet' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--list' || a === '-l') opts.list = true;
    else if (a === '--help' || a === '-h') opts.help = true;
    else if (a === '--no-color') { /* handled at module load */ }
    else if (a === '--delay' || a === '-d') {
      const next = args[i + 1];
      const n = Number(next);
      if (!Number.isFinite(n) || n < 0) {
        stderr(`error: --delay expects a non-negative number of seconds, got: ${next}`);
        exit(2);
      }
      opts.delay = n;
      i++;
    } else if (a.startsWith('--delay=')) {
      const n = Number(a.slice('--delay='.length));
      if (!Number.isFinite(n) || n < 0) {
        stderr(`error: --delay expects a non-negative number of seconds, got: ${a}`);
        exit(2);
      }
      opts.delay = n;
    } else if (a === '--data-dir') {
      const next = args[i + 1];
      if (next === undefined || next.startsWith('-')) {
        stderr(`error: --data-dir expects a path argument`);
        exit(2);
      }
      opts.dataDir = next;
      i++;
    } else if (a.startsWith('--data-dir=')) {
      opts.dataDir = a.slice('--data-dir='.length);
    } else if (!a.startsWith('-') && opts.type === null) {
      opts.type = a;
    } else {
      stderr(`error: unknown arg: ${a}`);
      exit(2);
    }
  }
  return opts;
}

function stderr(msg) {
  process.stderr.write(msg + '\n');
}

function printHelp() {
  stdout.write(`Usage: node scripts/simulate-claude-prompts.mjs <type> [--delay SECONDS] [--no-color] [--data-dir PATH]

Two modes, picked from <type>:
  - Terminal types (numbered-* / yesno-* / generic-*) emit to stdout for the
    §52 terminal-prompt overlay (server-side PTY scanner).
  - Permission types (permission-*) POST to the channel server's
    /permission/inject endpoint for the §47 permission popup. Long /
    'truncated' variants exercise the HS-8171 v2 live-terminal-borrow path.

Types:
`);
  const width = Math.max(...Object.keys(TYPES).map((k) => k.length));
  for (const [k, v] of Object.entries(TYPES)) {
    stdout.write(`  ${k.padEnd(width)}  ${v.description}\n`);
  }
  stdout.write(`
Options:
  --delay, -d N   Wait N seconds before firing (default 0). Useful when you
                  need to switch tabs / set up the UI first.
  --no-color      Disable ANSI colors (NO_COLOR=1 also works).
  --data-dir PATH Path to the Hot Sheet data dir (default '.hotsheet').
                  Permission types read <data-dir>/channel-port from here.
  --list, -l      Print this list and exit.
  --help, -h      Print this help and exit.

Examples:
  node scripts/simulate-claude-prompts.mjs numbered-2
  node scripts/simulate-claude-prompts.mjs yesno-yes-default --delay 3
  node scripts/simulate-claude-prompts.mjs random -d 2
  node scripts/simulate-claude-prompts.mjs permission-edit-long
  node scripts/simulate-claude-prompts.mjs permission-bash-short --data-dir /tmp/.hotsheet
`);
}

function sleep(seconds) {
  if (seconds <= 0) return Promise.resolve();
  return new Promise((res) => setTimeout(res, seconds * 1000));
}

// ---------------------------------------------------------------------------
// Response loop
// ---------------------------------------------------------------------------

function readResponse() {
  return new Promise((resolve) => {
    let buf = '';
    const onData = (chunk) => {
      const s = chunk.toString();
      for (const ch of s) {
        if (ch === '\x1b') {
          stdin.removeListener('data', onData);
          resolve({ kind: 'cancel' });
          return;
        }
        if (ch === '\r' || ch === '\n') {
          stdin.removeListener('data', onData);
          resolve({ kind: 'submit', text: buf });
          return;
        }
        buf += ch;
      }
    };
    stdin.on('data', onData);
  });
}

// ---------------------------------------------------------------------------
// §47 channel-server permission injection (HS-8205)
// ---------------------------------------------------------------------------

function readChannelPort(dataDir) {
  const portFile = join(dataDir, 'channel-port');
  let raw;
  try { raw = readFileSync(portFile, 'utf-8').trim(); }
  catch { return null; }
  const port = parseInt(raw, 10);
  if (!Number.isFinite(port) || port <= 0) return null;
  return port;
}

async function injectPermission(opts, entry) {
  const port = readChannelPort(opts.dataDir);
  if (port === null) {
    stderr(c.bold(c.red(`error: no channel-port file at ${join(opts.dataDir, 'channel-port')}`)));
    stderr(c.dim('  Hot Sheet must be running with a connected channel server.'));
    stderr(c.dim('  Connect it from Claude Code via /mcp, or pass --data-dir <path>.'));
    exit(2);
  }
  const url = `http://127.0.0.1:${port}/permission/inject`;
  const t0 = Date.now();
  const requestId = `sim_${t0.toString(36)}_${Math.random().toString(16).slice(2, 8)}`;
  const body = JSON.stringify({
    request_id: requestId,
    tool_name: entry.permission.tool_name,
    description: entry.permission.description,
    input_preview: entry.permission.input_preview,
  });
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    });
  } catch (err) {
    stderr(c.bold(c.red(`error: POST ${url} failed: ${err instanceof Error ? err.message : String(err)}`)));
    exit(1);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    stderr(c.bold(c.red(`error: POST ${url} returned ${res.status}: ${text}`)));
    exit(1);
  }
  stderr(c.bold(c.green(`  ← injected ${entry.permission.tool_name} permission (request_id=${requestId})`)));
  stderr(c.dim('  Click Allow / Deny / X in the Hot Sheet UI to dismiss.'));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = argv.slice(2).filter((a) => a !== '--no-color');
  const opts = parseArgs(args);

  if (opts.help) {
    printHelp();
    exit(0);
  }
  if (opts.list || opts.type === null) {
    printHelp();
    exit(opts.list ? 0 : 2);
  }

  const entry = TYPES[opts.type];
  if (entry === undefined) {
    stderr(`error: unknown type "${opts.type}". Run with --list to see options.`);
    exit(2);
  }

  if (opts.delay > 0) {
    stderr(c.dim(`(waiting ${opts.delay}s before firing…)`));
    await sleep(opts.delay);
  }

  // Permission-popup mode — POST to channel server, exit. No stdin loop.
  if (entry.permission !== undefined) {
    await injectPermission(opts, entry);
    exit(0);
  }

  entry.emit();

  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');

  const resp = await readResponse();
  // Emit the response echo to stderr so stdout only carries the prompt
  // itself — keeps shell-pipe consumers (incl. the §52-parser regression
  // test in `simulate-claude-prompts.test.ts`) from seeing the trailing
  // confirmation as part of the prompt buffer.
  if (resp.kind === 'cancel') {
    stderr(c.bold(c.red('  ← cancelled (Esc)')));
  } else {
    const text = resp.text === '' ? '<empty / Enter>' : JSON.stringify(resp.text);
    stderr(c.bold(c.green('  ← response: ')) + text);
  }
  exit(0);
}

main().catch((err) => {
  stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
  exit(1);
});
