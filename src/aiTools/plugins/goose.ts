// HS-9490 (docs/132) — Goose. Command resolution only; the ACP drive is deferred
// (HS-9347) and its instruction/skills conventions are unverified (not installed).
//
// docs/132 §132.4.1 calls this the STRESS CASE for the interface: identity plus a
// command and nothing else. It has no detection paths because it has no instruction
// file convention we have confirmed — inventing one would be a guess, and every other
// entry here is pinned by a live check.

import type { AiToolPlugin } from '../types.js';

export const goosePlugin: AiToolPlugin = {
  id: 'goose',
  displayName: 'Goose',
  productName: 'Goose',
  tier: 'cli-agent',
  devGateKey: 'dev_tool_goose',
  detection: { binaries: ['goose'], paths: [] },
};
