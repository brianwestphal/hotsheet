// HS-9313 (docs/113 §113.3) — the channel busy indicator's agent label ("OpenCode
// working" vs "Claude working"). The pure map now lives in the server-safe shared module
// `src/agentDisplayName.ts` (HS-9345 — the `/channel/done` Commands Log entry needs it
// too); this re-exports it so existing client imports keep working.

export { agentDisplayName } from '../agentDisplayName.js';
