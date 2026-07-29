// HS-9490 (docs/132) — Cursor. Tier-B (docs/113 §113.2): Hot Sheet supplies rules and
// instructions; it is not terminal-driven, so it has no command, drive or permissions.

import type { AiToolPlugin } from '../types.js';

export const cursorPlugin: AiToolPlugin = {
  id: 'cursor',
  displayName: 'Cursor',
  productName: 'Cursor',
  tier: 'editor',
  devGateKey: null, // Tier-B tools are never gated — nothing half-built to hide
  detection: { binaries: ['cursor'], paths: ['.cursor'] },
};
