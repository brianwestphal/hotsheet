// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _getTerminalsForTests,
  _resetTerminalsForTests,
  addTerminalEntry,
  COMMAND_INPUT_PLACEHOLDER,
  deriveNameFromCommand,
} from './terminalsSettings.js';

describe('COMMAND_INPUT_PLACEHOLDER (HS-7895)', () => {
  it('is not the {{claudeCommand}} sentinel — placeholder must not show an unresolved template tag', () => {
    expect(COMMAND_INPUT_PLACEHOLDER).not.toContain('{{claudeCommand}}');
    expect(COMMAND_INPUT_PLACEHOLDER).not.toContain('{{');
    expect(COMMAND_INPUT_PLACEHOLDER).not.toContain('}}');
  });

  it('is non-empty so the empty-state field still gets a discoverable cue', () => {
    expect(COMMAND_INPUT_PLACEHOLDER.length).toBeGreaterThan(0);
  });
});

describe('deriveNameFromCommand (HS-7858)', () => {
  it('returns "Claude" for the {{claudeCommand}} sentinel', () => {
    expect(deriveNameFromCommand('{{claudeCommand}}')).toBe('Claude');
  });

  it('returns the basename of a Unix shell path', () => {
    expect(deriveNameFromCommand('/bin/zsh')).toBe('zsh');
    expect(deriveNameFromCommand('/usr/bin/bash')).toBe('bash');
    expect(deriveNameFromCommand('/usr/local/bin/fish')).toBe('fish');
  });

  it('strips .exe / .cmd / .ps1 / .bat extensions on Windows paths', () => {
    expect(deriveNameFromCommand('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
    expect(deriveNameFromCommand('C:\\Program Files\\PowerShell\\7\\pwsh.exe')).toBe('pwsh');
    expect(deriveNameFromCommand('powershell.ps1')).toBe('powershell');
    expect(deriveNameFromCommand('init.bat')).toBe('init');
  });

  it('handles a bare command name with no path', () => {
    expect(deriveNameFromCommand('zsh')).toBe('zsh');
    expect(deriveNameFromCommand('claude')).toBe('claude');
  });

  it('returns empty string for blank / whitespace-only input', () => {
    expect(deriveNameFromCommand('')).toBe('');
    expect(deriveNameFromCommand('   ')).toBe('');
  });

  it('preserves a name with no extension and no separators', () => {
    expect(deriveNameFromCommand('npm run dev')).toBe('npm run dev');
  });

  it('is case-insensitive when stripping extensions', () => {
    expect(deriveNameFromCommand('C:\\Tools\\bash.EXE')).toBe('bash');
    expect(deriveNameFromCommand('Setup.Cmd')).toBe('Setup');
  });
});

/**
 * HS-7958 — the Add Terminal flow defers writing to `terminals[]` until
 * the final "Add Terminal" button click. Clicking the X (or the backdrop)
 * discards the in-progress draft entirely so the user can abandon a
 * half-typed new terminal without leaving a stub row in the configured
 * list. Pre-fix, `addTerminalEntry` pushed a blank entry up front; X just
 * "saved and closed" the same as Done.
 */
describe('addTerminalEntry — HS-7958 deferred-create + X-cancels-creation', () => {
  beforeEach(() => {
    _resetTerminalsForTests();
    document.body.innerHTML = '';
    // The dialog needs an `<ol id="terminal-settings-list">` mount-point so
    // `renderList()` (called downstream of commit) doesn't NPE on a missing
    // container. The test only inspects `_getTerminalsForTests`, not the
    // rendered list, so an empty <ol> is enough.
    const list = document.createElement('ol');
    list.id = 'terminal-settings-list';
    document.body.appendChild(list);
    // Stub fetch so loadCommandSuggestions / scheduleSave don't blow up
    // when wired downstream of the open / commit paths.
    const fetchSpy = vi.fn((input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : (input instanceof URL ? input.toString() : input.url);
      if (url.includes('/terminal/command-suggestions')) {
        return Promise.resolve(new Response(JSON.stringify({ suggestions: ['{{claudeCommand}}', '/bin/zsh'] }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }));
      }
      // /file-settings PATCH — return the empty merged shape so scheduleSave
      // resolves cleanly. Also covers the GET path used by other helpers.
      return Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    });
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
    _resetTerminalsForTests();
  });

  it('opening the Add dialog does NOT push a stub entry into terminals[]', () => {
    expect(_getTerminalsForTests().length).toBe(0);
    addTerminalEntry();
    expect(_getTerminalsForTests().length).toBe(0);
    // Sanity: the overlay is mounted.
    expect(document.querySelector('.cmd-editor-overlay')).not.toBeNull();
  });

  it('the Add dialog header reads "New Terminal" (not "Edit Terminal")', () => {
    addTerminalEntry();
    const header = document.querySelector('.cmd-editor-dialog-header span')?.textContent;
    expect(header).toBe('New Terminal');
  });

  it('the footer button text is "Add Terminal" in add-mode', () => {
    addTerminalEntry();
    const btn = document.querySelector('.cmd-editor-done-btn')?.textContent;
    expect(btn).toBe('Add Terminal');
  });

  it('clicking X on the Add dialog discards the draft (no entry persisted)', () => {
    addTerminalEntry();
    expect(_getTerminalsForTests().length).toBe(0);
    const closeBtn = document.querySelector('.cmd-editor-close-btn') as HTMLButtonElement;
    closeBtn.click();
    expect(_getTerminalsForTests().length).toBe(0);
    expect(document.querySelector('.cmd-editor-overlay')).toBeNull();
  });

  it('clicking the backdrop on the Add dialog also discards the draft', () => {
    addTerminalEntry();
    expect(_getTerminalsForTests().length).toBe(0);
    const overlay = document.querySelector('.cmd-editor-overlay') as HTMLElement;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // The handler keys on `e.target === overlay`; dispatching from the
    // overlay element itself satisfies that guard.
    expect(_getTerminalsForTests().length).toBe(0);
  });
});
