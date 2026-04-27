import { describe, expect, it } from 'vitest';

import { COMMAND_INPUT_PLACEHOLDER, deriveNameFromCommand } from './terminalsSettings.js';

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
