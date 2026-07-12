// HS-9330 — the shared option-driven permission model.
import { describe, expect, it } from 'vitest';

import {
  firstAllowOption, firstRejectOption, isAllowKind, isRememberKind,
  optionById, optionKindToBehavior, type PermissionOption, standardClaudeOptions,
} from './permissionOptions.js';

describe('isAllowKind / isRememberKind (HS-9330)', () => {
  it('classifies the four ACP kinds', () => {
    expect(isAllowKind('allow_once')).toBe(true);
    expect(isAllowKind('allow_always')).toBe(true);
    expect(isAllowKind('reject_once')).toBe(false);
    expect(isAllowKind('reject_always')).toBe(false);
    expect(isAllowKind('weird')).toBe(false);
    expect(isRememberKind('allow_always')).toBe(true);
    expect(isRememberKind('reject_always')).toBe(true);
    expect(isRememberKind('allow_once')).toBe(false);
  });
});

describe('optionKindToBehavior (HS-9330)', () => {
  it('maps allow variants to allow, everything else (fail-closed) to deny', () => {
    expect(optionKindToBehavior('allow_once')).toBe('allow');
    expect(optionKindToBehavior('allow_always')).toBe('allow');
    expect(optionKindToBehavior('reject_once')).toBe('deny');
    expect(optionKindToBehavior('reject_always')).toBe('deny');
    expect(optionKindToBehavior('unknown-new-kind')).toBe('deny'); // fail-closed
  });
});

describe('standardClaudeOptions (HS-9330)', () => {
  it('synthesizes the allow / allow-always / deny triple', () => {
    const opts = standardClaudeOptions();
    expect(opts.map(o => o.optionId)).toEqual(['allow', 'allow_always', 'deny']);
    expect(opts.map(o => o.kind)).toEqual(['allow_once', 'allow_always', 'reject_once']);
    // each option round-trips to the correct legacy behavior
    expect(opts.map(o => optionKindToBehavior(o.kind))).toEqual(['allow', 'allow', 'deny']);
  });
});

describe('optionById / firstAllowOption / firstRejectOption (HS-9330)', () => {
  const acpOptions: PermissionOption[] = [
    { optionId: 'a1', name: 'Allow once', kind: 'allow_once' },
    { optionId: 'a2', name: 'Always allow', kind: 'allow_always' },
    { optionId: 'r1', name: 'Reject', kind: 'reject_once' },
  ];

  it('optionById finds a present option, null otherwise', () => {
    expect(optionById(acpOptions, 'a2')?.name).toBe('Always allow');
    expect(optionById(acpOptions, 'nope')).toBeNull();
  });

  it('firstAllowOption prefers the exact remember-ness, else any allow', () => {
    expect(firstAllowOption(acpOptions, false)?.optionId).toBe('a1'); // allow_once
    expect(firstAllowOption(acpOptions, true)?.optionId).toBe('a2');  // allow_always
    expect(firstAllowOption([{ optionId: 'x', name: 'Grant', kind: 'allow_always' }], false)?.optionId).toBe('x'); // any allow
    expect(firstAllowOption([{ optionId: 'r', name: 'No', kind: 'reject_once' }])).toBeNull(); // no allow offered
  });

  it('firstRejectOption prefers reject_once, else any reject', () => {
    expect(firstRejectOption(acpOptions)?.optionId).toBe('r1');
    expect(firstRejectOption([{ optionId: 'ra', name: 'Never', kind: 'reject_always' }])?.optionId).toBe('ra');
    expect(firstRejectOption([{ optionId: 'a', name: 'Yes', kind: 'allow_once' }])).toBeNull();
  });
});
