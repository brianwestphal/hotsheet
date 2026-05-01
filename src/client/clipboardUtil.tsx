import { api } from './api.js';
import { byId } from './dom.js';
import { renderIconSvg } from './icons.js';
import type { Ticket } from './state.js';
import { showSkillsBanner } from './tauriIntegration.js';

const ICON_CHECK_13 = renderIconSvg('<path d="M20 6L9 17l-5-5"/>', 13);
const ICON_COPY_13 = renderIconSvg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', 13);

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

export function bindCopyPrompt() {
  const section = byId('copy-prompt-section');
  const btn = byId('copy-prompt-btn');
  const label = byId('copy-prompt-label');
  const icon = byId('copy-prompt-icon');
  let prompt = '';

  void api<{ prompt: string; skillCreated: boolean }>('/worklist-info').then((info) => {
    prompt = info.prompt;
    section.style.display = '';
    if (info.skillCreated) {
      showSkillsBanner();
    }
  });

  btn.addEventListener('click', () => {
    if (prompt === '') return;
    void navigator.clipboard.writeText(prompt).then(() => {
      label.textContent = 'Copied!';
      icon.innerHTML = ICON_CHECK_13;
      setTimeout(() => {
        label.textContent = 'Copy AI prompt';
        icon.innerHTML = ICON_COPY_13;
      }, 1500);
    });
  });
}
