/**
 * HS-8764 — the Announcer model registry: the default must be the cheapest
 * model, and the list must stay ordered cheapest-first.
 */
import { describe, expect, it } from 'vitest';

import { ANNOUNCER_MODEL_IDS, ANNOUNCER_MODELS, DEFAULT_ANNOUNCER_MODEL } from './models.js';

describe('announcer models (HS-8764)', () => {
  it('defaults to the cheapest model (Haiku), first in the list', () => {
    expect(DEFAULT_ANNOUNCER_MODEL).toBe('claude-haiku-4-5');
    expect(ANNOUNCER_MODEL_IDS[0]).toBe(DEFAULT_ANNOUNCER_MODEL);
  });

  it('keeps the id list and the labeled list in sync', () => {
    expect(ANNOUNCER_MODELS.map(m => m.id)).toEqual([...ANNOUNCER_MODEL_IDS]);
  });
});
