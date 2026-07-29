// HS-9490 (docs/132) — Windsurf. Tier-B, same shape as Cursor.

import type { AiToolPlugin } from '../types.js';

export const windsurfPlugin: AiToolPlugin = {
  id: 'windsurf',
  displayName: 'Windsurf',
  productName: 'Windsurf',
  tier: 'editor',
  devGateKey: null,
  detection: { binaries: ['windsurf'], paths: ['.windsurf'] },
};
