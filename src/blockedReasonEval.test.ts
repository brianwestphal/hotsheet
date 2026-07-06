// HS-9337 — the pure blocked_reason re-evaluation analyzer.
import { describe, expect, it } from 'vitest';

import { analyzeBlockedReason, extractTicketRefs, formatUnblockHint } from './blockedReasonEval.js';

describe('extractTicketRefs (HS-9337)', () => {
  it('pulls HS-NNNN refs, dedupes + uppercases, preserves order', () => {
    expect(extractTicketRefs('waiting on HS-1234 and hs-1234 then ABC-42')).toEqual(['HS-1234', 'ABC-42']);
  });
  it('does NOT match lowercase tokens like utf-8', () => {
    expect(extractTicketRefs('encode as utf-8 and gzip-9')).toEqual([]);
  });
  it('returns [] for prose with no refs', () => {
    expect(extractTicketRefs('waiting on the external vendor release')).toEqual([]);
  });
});

describe('analyzeBlockedReason (HS-9337)', () => {
  const statusMap = (m: Record<string, string>) => (ref: string): string | null => m[ref] ?? null;

  it('flags allKnownComplete when every referenced ticket is completed/verified', () => {
    const a = analyzeBlockedReason('blocked by HS-1 and HS-2', statusMap({ 'HS-1': 'completed', 'HS-2': 'verified' }));
    expect(a.allKnownComplete).toBe(true);
    expect(a.completeRefs).toEqual(['HS-1', 'HS-2']);
    expect(a.incompleteRefs).toEqual([]);
  });

  it('is NOT allKnownComplete when a referenced ticket is still open', () => {
    const a = analyzeBlockedReason('blocked by HS-1 and HS-2', statusMap({ 'HS-1': 'completed', 'HS-2': 'started' }));
    expect(a.allKnownComplete).toBe(false);
    expect(a.incompleteRefs).toEqual(['HS-2']);
  });

  it('ignores stray non-ticket tokens (unknown → not a blocker), hinting on known refs', () => {
    // HS-1 done; API-2 is not a real ticket (statusOf → null) → ignored.
    const a = analyzeBlockedReason('blocked by HS-1 and the API-2 release', statusMap({ 'HS-1': 'verified' }));
    expect(a.knownRefs).toEqual(['HS-1']);
    expect(a.allKnownComplete).toBe(true);
  });

  it('is NOT allKnownComplete when there are no known refs (prose-only)', () => {
    const a = analyzeBlockedReason('waiting on the vendor', statusMap({}));
    expect(a.knownRefs).toEqual([]);
    expect(a.allKnownComplete).toBe(false);
  });
});

describe('formatUnblockHint (HS-9337)', () => {
  const statusMap = (m: Record<string, string>) => (ref: string): string | null => m[ref] ?? null;

  it('returns a suggest-only hint naming the completed refs when all are done', () => {
    const hint = formatUnblockHint(analyzeBlockedReason('needs HS-9 done', statusMap({ 'HS-9': 'completed' })));
    expect(hint).toContain('HS-9');
    expect(hint).toContain('Possibly unblocked');
    expect(hint).toContain('blocked_reason'); // tells the agent HOW to clear it
  });

  it('returns null when a blocker is still open (no hint)', () => {
    const hint = formatUnblockHint(analyzeBlockedReason('needs HS-9', statusMap({ 'HS-9': 'not_started' })));
    expect(hint).toBeNull();
  });

  it('returns null for prose-only reasons', () => {
    const hint = formatUnblockHint(analyzeBlockedReason('waiting on a decision', statusMap({})));
    expect(hint).toBeNull();
  });
});
