/**
 * HS-9130 — the composite tile-key helpers (`${secret}::${id}`). Pure; pins the
 * HS-8285 invariant that tiles are keyed by secret+id (not id alone) so two
 * projects' `default` terminals don't collide.
 */
import { describe, expect, it } from 'vitest';

import { tileKey, tileKeyFor } from './terminalTileGridKeys.js';

describe('terminalTileGridKeys', () => {
  it('tileKey composes secret + id with the :: separator', () => {
    expect(tileKey('secretA', 'default')).toBe('secretA::default');
  });
  it('tileKeyFor delegates to tileKey for an entry object', () => {
    expect(tileKeyFor({ secret: 'secretB', id: 'term-1' })).toBe('secretB::term-1');
  });
  it('two projects with the same terminal id produce distinct keys (HS-8285)', () => {
    expect(tileKey('p1', 'default')).not.toBe(tileKey('p2', 'default'));
  });
});
