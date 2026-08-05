import { describe, expect, it } from 'vitest';

import { tileLabel as gridTileLabel } from './drawerTerminalGrid.js';
import { tabDisplayName } from './terminalInstanceLabel.js';
import { deriveTerminalLabel } from './terminalLabelFromCommand.js';

/**
 * HS-9584 — a nameless AI terminal used to be labelled `claude` on every
 * surface, whatever tool the project actually runs. The command template is
 * `ai_tool`-aware (`{{aiCommand}}` / the legacy `{{claudeCommand}}` alias both
 * expand through `pickAiCommand`); only the label asserted a tool.
 *
 * The label lives in ONE place now. The last block below is the part that keeps
 * it that way — the bug's real shape was three copies of the same six lines, so
 * fixing one would have left the others disagreeing.
 */
describe('deriveTerminalLabel (HS-9584)', () => {
  it('says "AI" for the tool-aware template, not the name of one tool', () => {
    expect(deriveTerminalLabel('{{aiCommand}}')).toBe('AI');
  });

  it('says "AI" for the legacy `{{claudeCommand}}` alias too', () => {
    // The old spelling is kept for back-compat (HS-8009) and is NOT
    // claude-specific — it resolves through the same `pickAiCommand`. Labelling
    // it "claude" was the bug in its purest form.
    expect(deriveTerminalLabel('{{claudeCommand}}')).toBe('AI');
  });

  it('ignores arguments after the template', () => {
    expect(deriveTerminalLabel('{{aiCommand}} --resume')).toBe('AI');
  });

  it('is case-insensitive about the token', () => {
    expect(deriveTerminalLabel('{{AICommand}}')).toBe('AI');
  });

  it('still says "claude" when the command IS literally claude', () => {
    // Not a regression of the fix: a user who typed the binary named the tool
    // themselves, and the label should reflect what will actually run.
    expect(deriveTerminalLabel('claude')).toBe('claude');
    expect(deriveTerminalLabel('claude --resume')).toBe('claude');
  });

  it('does not smuggle "AI" into an unrelated command that merely contains it', () => {
    // The old check was `includes('claude')`; an exact-token match is what stops
    // the mirror-image bug where a real binary gets mislabelled.
    expect(deriveTerminalLabel('aicommander')).toBe('aicommander');
    expect(deriveTerminalLabel('claudette')).toBe('claudette');
  });

  it('takes the basename of a path-style command', () => {
    expect(deriveTerminalLabel('/bin/zsh')).toBe('zsh');
    expect(deriveTerminalLabel('C:\\Windows\\System32\\cmd.exe')).toBe('cmd');
  });

  it('falls back to "terminal" for an empty or whitespace command', () => {
    expect(deriveTerminalLabel('')).toBe('terminal');
    expect(deriveTerminalLabel('   ')).toBe('terminal');
  });
});

describe('every surface derives the same label (HS-9584)', () => {
  // The bug was three copies of this logic. These assertions fail if any surface
  // grows its own again — which is the only way the fix comes undone.
  const CASES = ['{{aiCommand}}', '{{claudeCommand}}', '/bin/zsh', 'claude', ''];

  it('drawer tab and drawer tile grid agree with the shared helper', () => {
    for (const command of CASES) {
      const expected = deriveTerminalLabel(command);
      expect(tabDisplayName({ id: 't', command })).toBe(expected);
      expect(gridTileLabel({ id: 't', command })).toBe(expected);
    }
  });

  it('an explicit name still wins on both surfaces', () => {
    expect(tabDisplayName({ id: 't', name: 'Deploy', command: '{{aiCommand}}' })).toBe('Deploy');
    expect(gridTileLabel({ id: 't', name: 'Deploy', command: '{{aiCommand}}' })).toBe('Deploy');
  });
});
