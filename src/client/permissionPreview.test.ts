import { describe, expect, it } from 'vitest';

import { formatEditDiff, formatInputPreview } from './permissionPreview.js';

describe('formatInputPreview (HS-6634)', () => {
  it('returns empty string for empty input', () => {
    expect(formatInputPreview('Bash', '')).toBe('');
  });

  it('returns plain (non-JSON) input untouched', () => {
    expect(formatInputPreview('Bash', 'npm run build')).toBe('npm run build');
    expect(formatInputPreview('Bash', '  echo hi  ')).toBe('  echo hi  ');
  });

  it('returns input untouched when JSON-like text fails to parse', () => {
    const garbage = '{not valid json';
    expect(formatInputPreview('Bash', garbage)).toBe(garbage);
  });

  it('extracts just the command for Bash JSON input', () => {
    const raw = JSON.stringify({
      command: 'jq -cn --arg n "Added object-fit" \'{"x":$n}\'',
      description: 'Build JSON body',
    });
    expect(formatInputPreview('Bash', raw)).toBe('jq -cn --arg n "Added object-fit" \'{"x":$n}\'');
  });

  it('extracts the file_path for Read', () => {
    expect(formatInputPreview('Read', '{"file_path":"/etc/hosts"}')).toBe('/etc/hosts');
  });

  it('extracts the url for WebFetch', () => {
    expect(formatInputPreview('WebFetch', '{"url":"https://example.com","prompt":"Summarise"}')).toBe('https://example.com');
  });

  it('extracts the query for WebSearch', () => {
    expect(formatInputPreview('WebSearch', '{"query":"hot sheet docs"}')).toBe('hot sheet docs');
  });

  it('extracts the pattern for Glob', () => {
    expect(formatInputPreview('Glob', '{"pattern":"src/**/*.tsx"}')).toBe('src/**/*.tsx');
  });

  it('falls back to key: value for unknown tools', () => {
    const raw = JSON.stringify({ file_path: '/tmp/x', limit: 50 });
    expect(formatInputPreview('Read-something-new', raw)).toBe('file_path: /tmp/x\nlimit: 50');
  });

  it('indents multi-line string values under their key', () => {
    const raw = JSON.stringify({
      file_path: '/tmp/x',
      old_string: 'line one\nline two',
    });
    const out = formatInputPreview('Edit', raw);
    expect(out).toBe('file_path: /tmp/x\nold_string:\n  line one\n  line two');
  });

  it('serialises nested objects as JSON', () => {
    const raw = JSON.stringify({ todos: [{ subject: 'a' }, { subject: 'b' }] });
    expect(formatInputPreview('TodoWrite', raw)).toBe('todos: [{"subject":"a"},{"subject":"b"}]');
  });

  it('skips null/undefined values without crashing', () => {
    expect(formatInputPreview('Read', '{"file_path":null}')).toBe('{"file_path":null}');
  });

  it('returns input untouched for top-level JSON arrays', () => {
    expect(formatInputPreview('Bash', '[1,2,3]')).toBe('[1,2,3]');
  });

  it('falls back to original when Bash input has no command field', () => {
    const raw = '{"description":"no command here"}';
    expect(formatInputPreview('Bash', raw)).toBe('description: no command here');
  });

  // Claude's channel can truncate `input_preview` mid-JSON for long Bash
  // commands. We still recover the command prefix and append an ellipsis.
  it('recovers the Bash command from truncated JSON and marks it truncated', () => {
    const raw = '{"command":"jq -cn --arg n \\"Investigated; implementation deferred. Substantial refactor required\\nRoot cause review: CAPTURE_SCRIPT calls el.getBoundingClientRect() which r';
    const out = formatInputPreview('Bash', raw);
    expect(out.startsWith('jq -cn --arg n "Investigated; implementation deferred.')).toBe(true);
    expect(out).toContain('\nRoot cause review: CAPTURE_SCRIPT calls el.getBoundingClientRect() which r');
    expect(out.endsWith('…')).toBe(true);
    // No raw JSON punctuation leaked through
    expect(out.startsWith('{')).toBe(false);
    expect(out).not.toContain('\\"');
  });

  it('recovers file_path for Read from truncated JSON', () => {
    const raw = '{"file_path":"/tmp/a/very/long/pa';
    expect(formatInputPreview('Read', raw)).toBe('/tmp/a/very/long/pa…');
  });

  it('keeps raw text when truncated JSON has no recognised primary field', () => {
    const raw = '{"description":"half a string';
    expect(formatInputPreview('Bash', raw)).toBe(raw);
  });

  it('handles truncated JSON when command field is not first', () => {
    const raw = '{"description":"run build","command":"npm run build && npm';
    expect(formatInputPreview('Bash', raw)).toBe('npm run build && npm…');
  });
});

/**
 * HS-7951 — `formatEditDiff` extracts `old_string` / `new_string` (and
 * optional `file_path` / `replace_all`) from the Edit / Write tool's
 * `input_preview` JSON. Returns null for any non-Edit/Write tool, malformed
 * JSON without recoverable fields, or missing required fields.
 */
describe('formatEditDiff (HS-7951)', () => {
  it('returns null for tools that arent Edit / Write', () => {
    const raw = JSON.stringify({ old_string: 'a', new_string: 'b' });
    expect(formatEditDiff('Bash', raw)).toBeNull();
    expect(formatEditDiff('Read', raw)).toBeNull();
    expect(formatEditDiff('Glob', raw)).toBeNull();
  });

  it('returns null for empty input or non-JSON-shaped strings', () => {
    expect(formatEditDiff('Edit', '')).toBeNull();
    expect(formatEditDiff('Edit', 'not json at all')).toBeNull();
  });

  it('parses a well-formed Edit input with old_string / new_string', () => {
    const raw = JSON.stringify({
      file_path: '/tmp/foo.ts',
      old_string: 'const x = 1;',
      new_string: 'const x = 42;',
    });
    const out = formatEditDiff('Edit', raw);
    expect(out).not.toBeNull();
    expect(out!.oldStr).toBe('const x = 1;');
    expect(out!.newStr).toBe('const x = 42;');
    expect(out!.filePath).toBe('/tmp/foo.ts');
    expect(out!.replaceAll).toBe(false);
    expect(out!.truncated).toBe(false);
  });

  it('respects the replace_all flag when present', () => {
    const raw = JSON.stringify({ old_string: 'a', new_string: 'b', replace_all: true });
    const out = formatEditDiff('Edit', raw);
    expect(out!.replaceAll).toBe(true);
  });

  it('returns null when Edit is missing old_string or new_string', () => {
    expect(formatEditDiff('Edit', JSON.stringify({ old_string: 'a' }))).toBeNull();
    expect(formatEditDiff('Edit', JSON.stringify({ new_string: 'b' }))).toBeNull();
  });

  it('Write defaults old_string to "" when only new_string (or `content`) is present', () => {
    const out1 = formatEditDiff('Write', JSON.stringify({ file_path: '/tmp/x', new_string: 'hello' }));
    expect(out1).not.toBeNull();
    expect(out1!.oldStr).toBe('');
    expect(out1!.newStr).toBe('hello');

    // Some Write variants use `content` instead of `new_string`.
    const out2 = formatEditDiff('Write', JSON.stringify({ file_path: '/tmp/x', content: 'world' }));
    expect(out2).not.toBeNull();
    expect(out2!.newStr).toBe('world');
  });

  it('returns null for Write without new_string AND without content', () => {
    expect(formatEditDiff('Write', JSON.stringify({ file_path: '/tmp/x' }))).toBeNull();
  });

  it('returns null when the parsed JSON is null / array / scalar', () => {
    expect(formatEditDiff('Edit', 'null')).toBeNull();
    expect(formatEditDiff('Edit', '[1, 2, 3]')).toBeNull();
  });

  it('recovers from truncated JSON via the field-extractor fallback (Edit)', () => {
    // Truncated mid-newer-string — should still produce a diff, with
    // truncated=true.
    const raw = '{"file_path":"/tmp/x","old_string":"foo","new_string":"bar baz qux';
    const out = formatEditDiff('Edit', raw);
    expect(out).not.toBeNull();
    expect(out!.oldStr).toBe('foo');
    expect(out!.newStr).toBe('bar baz qux');
    expect(out!.filePath).toBe('/tmp/x');
    expect(out!.truncated).toBe(true);
  });

  it('truncated Edit without old_string returns null (caller falls back to flat preview)', () => {
    const raw = '{"file_path":"/tmp/x","new_string":"bar';
    expect(formatEditDiff('Edit', raw)).toBeNull();
  });

  it('truncated Write recovers via new_string-only extractor', () => {
    const raw = '{"file_path":"/tmp/x","new_string":"hello world';
    const out = formatEditDiff('Write', raw);
    expect(out).not.toBeNull();
    expect(out!.newStr).toBe('hello world');
    expect(out!.truncated).toBe(true);
  });

  // HS-8107 — modern Claude Write payloads use `content` instead of
  // `new_string`. The well-formed JSON path already supported this; the
  // truncated path missed it, so a long Write payload pushed the popup
  // onto the snapshot fallback and surfaced as a solid-black body.
  it('truncated Write recovers via content-field extractor (HS-8107)', () => {
    const raw = '{"file_path":"/tmp/x","content":"line one\\nline two and a half';
    const out = formatEditDiff('Write', raw);
    expect(out).not.toBeNull();
    expect(out!.oldStr).toBe('');
    expect(out!.newStr).toBe('line one\nline two and a half');
    expect(out!.filePath).toBe('/tmp/x');
    expect(out!.truncated).toBe(true);
  });

  it('truncated Write with neither new_string nor content returns null (defers to flat preview)', () => {
    const raw = '{"file_path":"/tmp/x","other":"unrelated';
    expect(formatEditDiff('Write', raw)).toBeNull();
  });

  it('handles non-string field values defensively (returns null for Edit)', () => {
    const raw = JSON.stringify({ old_string: 42, new_string: ['nope'] });
    expect(formatEditDiff('Edit', raw)).toBeNull();
  });
});
