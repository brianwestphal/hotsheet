// HS-9310 — pure ACP → Hot Sheet mapping (docs/114 §114.5-114.6).
import { describe, expect, it } from 'vitest';

import {
  type AcpPermissionOption,
  classifyUpdate,
  pickAllowOptionId,
  pickRejectOptionId,
  turnEndOutcome,
} from './acpMapping.js';

describe('classifyUpdate', () => {
  it('any update means busy; known kinds are recognized', () => {
    for (const k of ['plan', 'agent_message_chunk', 'tool_call', 'tool_call_update', 'usage_update']) {
      expect(classifyUpdate(k)).toEqual({ busy: true, known: true });
    }
  });
  it('an unknown update kind is still busy but flagged unknown', () => {
    expect(classifyUpdate('some_future_kind')).toEqual({ busy: true, known: false });
  });
});

describe('turnEndOutcome', () => {
  it('classifies the known stop reasons', () => {
    expect(turnEndOutcome('end_turn')).toBe('completed');
    expect(turnEndOutcome('cancelled')).toBe('stopped');
    expect(turnEndOutcome('max_tokens')).toBe('error');
    expect(turnEndOutcome('max_turn_requests')).toBe('error');
    expect(turnEndOutcome('refusal')).toBe('error');
  });
  it('an unknown terminal reason still ends the turn (never stuck busy)', () => {
    expect(turnEndOutcome('some_future_reason')).toBe('completed');
  });
});

const OPTS: AcpPermissionOption[] = [
  { optionId: 'a1', name: 'Allow', kind: 'allow_once' },
  { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
  { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  { optionId: 'r2', name: 'Always reject', kind: 'reject_always' },
];

describe('pickAllowOptionId', () => {
  it('picks the exact allow kind by the remember flag', () => {
    expect(pickAllowOptionId(OPTS, false)).toBe('a1'); // allow_once
    expect(pickAllowOptionId(OPTS, true)).toBe('a2');   // allow_always
  });
  it('falls back to any allow option when the exact kind is absent', () => {
    expect(pickAllowOptionId([{ optionId: 'x', name: 'OK', kind: 'allow_always' }], false)).toBe('x');
  });
  it('returns null when no allow option is offered (popup must be shown)', () => {
    expect(pickAllowOptionId([{ optionId: 'r', name: 'No', kind: 'reject_once' }], false)).toBeNull();
  });
});

describe('pickRejectOptionId', () => {
  it('prefers reject_once (do not silently remember a denial) unless remember', () => {
    expect(pickRejectOptionId(OPTS, false)).toBe('r1');
    expect(pickRejectOptionId(OPTS, true)).toBe('r2');
  });
  it('returns null when no reject option is offered', () => {
    expect(pickRejectOptionId([{ optionId: 'a', name: 'Yes', kind: 'allow_once' }], false)).toBeNull();
  });
});
