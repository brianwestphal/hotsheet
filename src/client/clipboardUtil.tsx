import { getWorklistInfo } from '../api/index.js';
import { isDemoMode } from './demoMode.js';
import type { Ticket } from './state.js';
import { showSkillsBanner } from './tauriIntegration.js';

function parseNotes(raw: string): { text: string; created_at: string }[] {
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as { text: string; created_at: string }[];
  } catch { /* not JSON */ }
  if (raw.trim()) return [{ text: raw, created_at: '' }];
  return [];
}

export function formatTicketForClipboard(ticket: Ticket): string {
  const lines: string[] = [];
  lines.push(`${ticket.ticket_number}: ${ticket.title}`);

  if (ticket.details.trim()) {
    lines.push('');
    lines.push(ticket.details.trim());
  }

  const notes = parseNotes(ticket.notes);
  if (notes.length > 0) {
    lines.push('');
    for (const note of notes) {
      lines.push(`- ${note.text}`);
    }
  }

  return lines.join('\n');
}

/** HS-8528 — was `bindCopyPrompt` (sidebar button + skill-creation
 *  banner trigger). The button itself is gone — AI tools consume the
 *  worklist via the `hotsheet_*` MCP tools / the `.hotsheet/worklist.md`
 *  file directly, so the user no longer needs to copy a one-shot
 *  prompt to the clipboard. What's still load-bearing is the
 *  skill-creation banner: when `/api/worklist-info`'s `skillCreated`
 *  flag is `true` (meaning the AI-tool skill files were just
 *  generated on this app boot, per `consumeSkillsCreatedFlag` in
 *  `src/routes/dashboard.ts`), surface the banner so the user knows
 *  to restart their AI tool. The endpoint's `prompt` field is
 *  ignored here — kept on the wire because the prior client
 *  consumed it; future cleanup could drop it from the response. */
export function initSkillsBanner(): void {
  // HS-8688 — suppress under `--demo:N`. The skills banner is the seeded
  // "AI tool skills created. Restart your AI tool to use the new ticket
  // creation skills (hs-bug, hs-feature, etc.)." strip; it leaks into demo
  // screenshots because every fresh demo boot creates a new skills directory
  // and the worklist-info endpoint reports `skillCreated: true` on first
  // poll. Demo mode never has a real AI tool to restart, so the banner is
  // pure noise. Gated alongside the other demo-mode suppressors in
  // `demoMode.ts`.
  if (isDemoMode()) return;
  void getWorklistInfo().then((info) => {
    if (info.skillCreated) showSkillsBanner();
  });
}
