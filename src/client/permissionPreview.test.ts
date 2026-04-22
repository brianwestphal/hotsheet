import { describe, expect, it } from 'vitest';

import { formatInputPreview } from './permissionPreview.js';

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
});
