// HS-9346 — the pure ACP auto-allow gate.
import { describe, expect, it } from 'vitest';

import type { AllowRule } from '../permissionAllowRules.js';
import { acpAutoAllowOptionId, acpToolCallRuleTarget } from './acpAutoAllow.js';
import type { AcpPermissionOption } from './acpMapping.js';

const OPTIONS: AcpPermissionOption[] = [
  { optionId: 'once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'always', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
];

const rule = (tool: string, pattern: string): AllowRule => ({ id: `r-${tool}`, tool, pattern, added_at: '' });

// Captured live shapes (docs/114 §114.12).
const EXECUTE = { toolCallId: 'c1', title: 'git status', kind: 'execute', rawInput: { command: 'git status' } };
const EDIT = { toolCallId: 'c2', title: '/repo/x.ts', kind: 'edit', rawInput: { filepath: '/repo/x.ts', diff: '…' } };

describe('acpToolCallRuleTarget (HS-9346)', () => {
  it('maps execute → Bash with the command as primary', () => {
    expect(acpToolCallRuleTarget(EXECUTE)).toEqual({ tool: 'Bash', primary: 'git status' });
  });
  it('maps read → Read, tolerating opencode field-name variants', () => {
    expect(acpToolCallRuleTarget({ kind: 'read', rawInput: { filePath: '/a' } })).toEqual({ tool: 'Read', primary: '/a' });
    expect(acpToolCallRuleTarget({ kind: 'read', rawInput: { filepath: '/b' } })).toEqual({ tool: 'Read', primary: '/b' });
    expect(acpToolCallRuleTarget({ kind: 'read', rawInput: { path: '/c' } })).toEqual({ tool: 'Read', primary: '/c' });
  });
  it('maps fetch → WebFetch with the url', () => {
    expect(acpToolCallRuleTarget({ kind: 'fetch', rawInput: { url: 'https://x' } })).toEqual({ tool: 'WebFetch', primary: 'https://x' });
  });
  it('falls back to the title when rawInput has no primary field', () => {
    expect(acpToolCallRuleTarget({ kind: 'execute', title: 'ls -la', rawInput: {} })).toEqual({ tool: 'Bash', primary: 'ls -la' });
  });
  it('returns null for non-allow-listable kinds + malformed input', () => {
    expect(acpToolCallRuleTarget(EDIT)).toBeNull();          // edit is never gated
    expect(acpToolCallRuleTarget({ kind: 'delete', rawInput: { path: '/x' } })).toBeNull();
    expect(acpToolCallRuleTarget({ kind: 'execute' })).toBeNull(); // no primary recoverable
    expect(acpToolCallRuleTarget(null)).toBeNull();
    expect(acpToolCallRuleTarget('nope')).toBeNull();
  });
});

describe('acpAutoAllowOptionId (HS-9346)', () => {
  it('returns the allow_once option when a Bash rule matches', () => {
    expect(acpAutoAllowOptionId(EXECUTE, OPTIONS, [rule('Bash', 'git status')])).toBe('once');
  });
  it('returns null when no rule matches → the popup must show', () => {
    expect(acpAutoAllowOptionId(EXECUTE, OPTIONS, [rule('Bash', 'rm -rf /')])).toBeNull();
    expect(acpAutoAllowOptionId(EXECUTE, OPTIONS, [])).toBeNull();
  });
  it('never auto-allows an edit — even with a (spurious) Edit rule, which the matcher refuses', () => {
    expect(acpAutoAllowOptionId(EDIT, OPTIONS, [rule('Edit', '.*')])).toBeNull();
  });
  it('anchors the rule pattern (git status ≠ git status && rm)', () => {
    const chained = { kind: 'execute', title: 'x', rawInput: { command: 'git status && rm -rf /' } };
    expect(acpAutoAllowOptionId(chained, OPTIONS, [rule('Bash', 'git status')])).toBeNull();
  });
  it('returns null when the agent offers no allow option (must show popup)', () => {
    const rejectOnly: AcpPermissionOption[] = [{ optionId: 'r', name: 'No', kind: 'reject_once' }];
    expect(acpAutoAllowOptionId(EXECUTE, rejectOnly, [rule('Bash', 'git status')])).toBeNull();
  });
});
