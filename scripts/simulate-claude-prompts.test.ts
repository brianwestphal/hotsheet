// HS-8196 — verify that every prompt type emitted by
// `scripts/simulate-claude-prompts.mjs` is detected by the §52 parser
// registry. Captures stdout, strips ANSI, splits to rows, runs through
// `runParserRegistry`, asserts a non-null match with the expected shape.
//
// HS-8205 — also covers the §47 permission-popup mode: verifies that the
// truncation-bait payloads we send actually trigger the `flatTruncated` /
// `diffTruncated` gates in `permissionOverlay.tsx` (which decide whether
// the popup borrows the live xterm via §54 checkout).

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';

import { runParserRegistry } from '../src/shared/terminalPrompt/parsers.js';
import { formatEditDiff, formatInputPreview } from '../src/client/permissionPreview.js';

const SCRIPT = join(__dirname, 'simulate-claude-prompts.mjs');

function emit(type: string): string[] {
  // Closing stdin makes the script's `readResponse` resolve immediately on
  // the first read, so the process exits without hanging the test.
  const result = spawnSync('node', [SCRIPT, type, '--no-color'], {
    input: '\n',
    encoding: 'utf8',
    timeout: 5_000,
  });
  if (result.error !== undefined && result.error !== null) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`exited with status ${String(result.status)}: ${result.stderr}`);
  }
  return result.stdout.split('\n');
}

const NUMBERED = ['numbered-2', 'numbered-5', 'numbered-diff', 'numbered-long', 'numbered-bash'];
const YESNO = ['yesno-lower', 'yesno-yes-default', 'yesno-no-default', 'yesno-words', 'yesno-paren'];
const GENERIC = ['generic-short', 'generic-context'];

describe('simulate-claude-prompts.mjs (HS-8196)', () => {
  for (const type of NUMBERED) {
    it(`emits a parseable claude-numbered prompt for type=${type}`, () => {
      const rows = emit(type);
      const match = runParserRegistry(rows);
      expect(match, `parser registry should detect ${type}`).not.toBeNull();
      expect(match?.parserId).toBe('claude-numbered');
      if (match !== null && match.shape === 'numbered') {
        expect(match.choices.length).toBeGreaterThanOrEqual(2);
      }
    });
  }

  for (const type of YESNO) {
    it(`emits a parseable yesno prompt for type=${type}`, () => {
      const rows = emit(type);
      const match = runParserRegistry(rows);
      expect(match, `parser registry should detect ${type}`).not.toBeNull();
      expect(match?.parserId).toBe('yesno');
    });
  }

  for (const type of GENERIC) {
    it(`emits a parseable generic prompt for type=${type}`, () => {
      const rows = emit(type);
      const match = runParserRegistry(rows);
      expect(match, `parser registry should detect ${type}`).not.toBeNull();
      // Generic falls through after numbered/yesno don't match.
      expect(match?.parserId).toBe('generic');
    });
  }

  it('--list exits 0 with help text', () => {
    const result = spawnSync('node', [SCRIPT, '--list'], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('numbered-2');
    expect(result.stdout).toContain('yesno-lower');
  });

  it('rejects an unknown type with a non-zero exit', () => {
    const result = spawnSync('node', [SCRIPT, 'does-not-exist', '--no-color'], {
      encoding: 'utf8',
      timeout: 5_000,
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('unknown type');
  });

  it('--delay 0 emits immediately (smoke test)', () => {
    const start = Date.now();
    emit('yesno-lower');
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_500); // generous — node start overhead
  });
});

// ---------------------------------------------------------------------------
// HS-8205 — permission-popup mode coverage
// ---------------------------------------------------------------------------

/** Run the script in permission mode, point it at a non-existent --data-dir
 *  so it fails BEFORE the network call. The stderr output reveals the
 *  payload shape the script would have sent (request_id is generated, but
 *  tool_name / description / input_preview are deterministic). */
function permissionDryRun(type: string): { stdout: string; stderr: string; status: number | null } {
  const result = spawnSync('node', [SCRIPT, type, '--no-color', '--data-dir', '/nonexistent/.hotsheet'], {
    encoding: 'utf8',
    timeout: 5_000,
  });
  return { stdout: result.stdout, stderr: result.stderr, status: result.status };
}

describe('simulate-claude-prompts.mjs permission-popup mode (HS-8205)', () => {
  it('--list includes every permission-* type', () => {
    const result = spawnSync('node', [SCRIPT, '--list'], { encoding: 'utf8', timeout: 5_000 });
    expect(result.status).toBe(0);
    for (const type of [
      'permission-bash-short',
      'permission-bash-long',
      'permission-edit-short',
      'permission-edit-long',
      'permission-write-long',
    ]) {
      expect(result.stdout).toContain(type);
    }
  });

  it('fails with a clear error when channel-port is missing', () => {
    const r = permissionDryRun('permission-bash-short');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no channel-port file');
  });

  // Pre-flight — the truncation-bait payloads embedded in the script must
  // actually trip the gates in permissionOverlay.tsx, otherwise running
  // `permission-*-long` produces a popup with the regular flat body and
  // the user never sees the live-terminal-borrow path the test was meant
  // to exercise. We re-build the same strings here and assert directly
  // against the shared helpers.
  describe('truncation-bait payloads trip the flatTruncated / diffTruncated gates', () => {
    const bashLong = '{"command":"' + (
      'find / -name \'*.log\' -mtime -1 -size +1M -not -path \'/proc/*\' -not -path \'/sys/*\' '
      + '| xargs -I {} sh -c \'echo === {} ===; tail -200 {}; echo\' '
      + '| awk \'/ERROR/{print FILENAME \\": \\" $0}\' '
    ).repeat(8);
    const editLong = '{"file_path":"/Users/me/project/src/very-long-renderer.tsx","old_string":"' + (
      'export function Renderer({ data }) {\\n'
      + '  return data.map(row => <Row key={row.id} data={row} />);\\n'
      + '}'
    ) + '","new_string":"' + (
      'export function Renderer({ data, columns, sort, filter, onSelect, onHover }: RendererProps) {\\n'
      + '  const sorted = useMemo(() => [...data].sort((a, b) => sort.direction === \\"asc\\" ? a[sort.column] - b[sort.column] : b[sort.column] - a[sort.column]), [data, sort]);\\n'
      + '  const filtered = useMemo(() => sorted.filter(row => filter.every(f => f.predicate(row))), [sorted, filter]);\\n'
    ).repeat(6);
    const writeLong = '{"file_path":"/Users/me/project/src/generated.ts","content":"' + (
      '// Auto-generated — do not edit.\\nexport const tableSchema = {\\n'
      + '  id: { type: \\"text\\", primary: true },\\n'
      + '  name: { type: \\"text\\", required: true },\\n'
      + '  created_at: { type: \\"timestamp\\", default: \\"now()\\" },\\n'
      + '};\\n'
    ).repeat(10);

    it('permission-bash-long ends in `…` (flatTruncated)', () => {
      expect(formatInputPreview('Bash', bashLong).endsWith('…')).toBe(true);
    });
    it('permission-edit-long → diffTruncated', () => {
      expect(formatEditDiff('Edit', editLong)?.truncated).toBe(true);
    });
    it('permission-write-long → diffTruncated', () => {
      expect(formatEditDiff('Write', writeLong)?.truncated).toBe(true);
    });
    it('permission-bash-short does NOT trip flatTruncated', () => {
      expect(formatInputPreview('Bash', JSON.stringify({ command: 'ls -la' })).endsWith('…')).toBe(false);
    });
    it('permission-edit-short does NOT trip diffTruncated', () => {
      const out = formatEditDiff('Edit', JSON.stringify({
        file_path: '/Users/me/project/src/example.ts',
        old_string: 'return parseInput(raw);',
        new_string: 'if (raw === null) return null;\nreturn parseInput(raw.trim());',
      }));
      expect(out?.truncated).toBe(false);
    });
  });
});
