import { describe, expect, it } from 'vitest';

import { collectCommandSuggestions } from './terminal.js';

/**
 * HS-7791 — Edit Terminal command combobox suggestions. The helper assembles
 * a deduplicated, ordered list of suggestions for the dialog: the
 * `{{claudeCommand}}` sentinel always leads, followed by the user's default
 * shell ($SHELL / %COMSPEC%), then any system-wide shells from /etc/shells
 * on Unix or well-known PowerShell + cmd locations on Windows.
 */
describe('collectCommandSuggestions', () => {
  it('always includes the {{claudeCommand}} sentinel as the first entry', () => {
    const out = collectCommandSuggestions();
    expect(out[0]).toBe('{{claudeCommand}}');
  });

  it('includes the user default shell when set on the env', () => {
    const out = collectCommandSuggestions();
    if (process.platform === 'win32') {
      const expected = process.env.COMSPEC ?? 'cmd.exe';
      expect(out).toContain(expected);
    } else {
      const expected = process.env.SHELL ?? '/bin/sh';
      expect(out).toContain(expected);
    }
  });

  it('returns a deduplicated list (no entry appears twice)', () => {
    const out = collectCommandSuggestions();
    const seen = new Set<string>();
    for (const s of out) {
      expect(seen.has(s)).toBe(false);
      seen.add(s);
    }
  });

  it('lists at least one shell beyond the sentinel on Unix-like systems with a populated /etc/shells', () => {
    if (process.platform === 'win32') return;
    const out = collectCommandSuggestions();
    // At minimum the sentinel + user shell. /etc/shells exists on macOS and
    // most Linux distros so we typically end up with several entries.
    expect(out.length).toBeGreaterThanOrEqual(2);
  });

  it('every entry is a non-empty trimmed string', () => {
    const out = collectCommandSuggestions();
    for (const s of out) {
      expect(typeof s).toBe('string');
      expect(s.length).toBeGreaterThan(0);
      expect(s).toBe(s.trim());
    }
  });
});
