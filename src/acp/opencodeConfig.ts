// HS-9341 — make OpenCode ASK for permission on ACP-driven play-button turns, so tool
// calls route to Hot Sheet's §47 overlay (docs/114 §114.5) instead of being silently
// auto-approved.
//
// By default OpenCode auto-approves tool calls in ACP mode — it never sends
// `session/request_permission`, so the overlay is never reached (verified live, docs/114
// §114.12). OpenCode has NO per-session ACP knob for this: `session/new`'s `configOptions`
// expose only `model` + `mode` (build/plan), and `session/set_config_option` rejects a
// `permission` key. Permission is a CONFIG-FILE setting.
//
// So Hot Sheet writes its OWN minimal config (`permission: ask`) under `.hotsheet/` and
// points OpenCode at it via the `OPENCODE_CONFIG` env var at spawn — WITHOUT touching the
// user's repo or global config. Crucially, `OPENCODE_CONFIG` is LOWER priority than the
// user's own project `opencode.json` (verified live: a project `permission.edit: allow`
// overrode our `ask`), so this behaves as a DEFAULT: the overlay is used when the user
// hasn't configured permission, but any user config wins — respecting a user who wants
// auto-approve.

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/** File name of Hot Sheet's managed OpenCode config, written under `<dataDir>` (which is
 *  `.hotsheet/`, already gitignored). */
export const OPENCODE_ACP_CONFIG_NAME = 'opencode-acp.json';

/** The managed config body: ask for permission on the tool classes that can change state
 *  or reach out, so each routes to the §47 overlay. A low-priority default (see module
 *  docs) — the user's own config overrides it. */
export function opencodeAcpConfigContent(): string {
  return JSON.stringify({
    $schema: 'https://opencode.ai/config.json',
    permission: { edit: 'ask', bash: 'ask', webfetch: 'ask' },
  }, null, 2) + '\n';
}

/**
 * Ensure `<dataDir>/opencode-acp.json` holds the ask-permission defaults and return its
 * path (for `OPENCODE_CONFIG`). Writes only when missing or stale — the play button can
 * fire often and `.hotsheet/` is watched, so needless rewrites are avoided.
 */
export function ensureOpencodeAcpConfig(dataDir: string): string {
  const path = join(dataDir, OPENCODE_ACP_CONFIG_NAME);
  const want = opencodeAcpConfigContent();
  let current: string | null = null;
  try { current = readFileSync(path, 'utf-8'); } catch { /* missing → write below */ }
  if (current !== want) writeFileSync(path, want, 'utf-8');
  return path;
}
