// HS-9380 — the multi-connection warning/toast wording must name the project's
// actual AI tool (pre-fix it always said "Claude") and only claim FIFO trigger
// routing / the `/mcp` reconnect hint on the claude-channel transport.
import { describe, expect, it } from 'vitest';

import { multiConnectionMessages } from './multiConnectionWarning.js';

describe('multiConnectionMessages', () => {
  it('claude-channel transport (claude / auto / unset) keeps the trigger-routing + /mcp wording', () => {
    for (const tool of ['claude', 'auto', '', undefined]) {
      const m = multiConnectionMessages(tool);
      expect(m.warning(2)).toBe('2 Claude connections active — triggers route to the oldest one. Disconnect all, then /mcp to reconnect the one you want.');
      expect(m.disconnectedToast(2)).toBe('Disconnected 2 Claude connections — run /mcp in the Claude you want to use to reconnect');
      expect(m.disconnectedToast(1)).toContain('1 Claude connection —'); // singular
      expect(m.noneToast).toBe('No Claude connections to disconnect');
    }
  });

  it('codex (mcp-hooks spawn drive) names Codex and drops the Claude-specific claims', () => {
    const m = multiConnectionMessages('codex');
    expect(m.warning(2)).toContain('2 Codex sessions');
    expect(m.warning(2)).not.toContain('Claude');
    expect(m.warning(2)).not.toContain('/mcp'); // Claude-specific reconnect hint
    expect(m.warning(2)).not.toContain('triggers route'); // spawn drives never misroute triggers
    expect(m.disconnectedToast(2)).toBe('Disconnected 2 Codex connections');
    expect(m.disconnectedToast(1)).toBe('Disconnected 1 Codex connection'); // singular
    expect(m.noneToast).toBe('No Codex connections to disconnect');
  });

  it('other spawn-drive tools get their own display name (antigravity / opencode)', () => {
    expect(multiConnectionMessages('antigravity').warning(3)).toContain('3 Antigravity sessions');
    expect(multiConnectionMessages('opencode').noneToast).toBe('No OpenCode connections to disconnect');
  });

  it('editor-only tools ride the claude-channel wording (their display name, Claude rails)', () => {
    // cursor et al. have no drive transport — deriveDefaultTransport says
    // claude-channel, so the FIFO-leader semantics genuinely apply.
    const m = multiConnectionMessages('cursor');
    expect(m.warning(2)).toContain('2 Cursor connections active — triggers route to the oldest one');
  });
});
