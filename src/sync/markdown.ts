import { writeFileSync } from 'fs';
import { join } from 'path';

import { getAttachments, getCategories, getSettings, getTickets } from '../db/queries.js';
import { readFileSettings } from '../file-settings.js';
import type { Ticket } from '../types.js';

interface AutoContextEntry {
  type: 'category' | 'tag';
  key: string;
  text: string;
}

let dataDir: string;
let port: number;
let worklistTimeout: ReturnType<typeof setTimeout> | null = null;
let openTicketsTimeout: ReturnType<typeof setTimeout> | null = null;

const WORKLIST_DEBOUNCE = 500;
const OPEN_TICKETS_DEBOUNCE = 5000;

export function initMarkdownSync(dir: string, serverPort: number) {
  dataDir = dir;
  port = serverPort;
}

export function scheduleWorklistSync() {
  if (worklistTimeout) clearTimeout(worklistTimeout);
  worklistTimeout = setTimeout(() => {
    void syncWorklist();
  }, WORKLIST_DEBOUNCE);
}

export function scheduleOpenTicketsSync() {
  if (openTicketsTimeout) clearTimeout(openTicketsTimeout);
  openTicketsTimeout = setTimeout(() => {
    void syncOpenTickets();
  }, OPEN_TICKETS_DEBOUNCE);
}

export function scheduleAllSync() {
  scheduleWorklistSync();
  scheduleOpenTicketsSync();
}

function parseTicketNotes(raw: string): { text: string; created_at: string }[] {
  if (raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as { text: string; created_at: string }[];
  } catch { /* not JSON */ }
  if (raw.trim() !== '') return [{ text: raw, created_at: '' }];
  return [];
}

async function formatTicket(ticket: Ticket, autoContext: AutoContextEntry[]): Promise<string> {
  const attachments = await getAttachments(ticket.id);
  const lines: string[] = [];

  lines.push(`TICKET ${ticket.ticket_number}:`);
  lines.push(`- ID: ${ticket.id}`);
  lines.push(`- Type: ${ticket.category}`);
  lines.push(`- Priority: ${ticket.priority}`);
  lines.push(`- Status: ${ticket.status.replace('_', ' ')}`);
  lines.push(`- Title: ${ticket.title}`);

  // Tags (displayed in Title Case)
  let ticketTags: string[] = [];
  try {
    const tags: unknown = JSON.parse(ticket.tags);
    if (Array.isArray(tags) && tags.length > 0) {
      ticketTags = tags as string[];
      const display = tags.map((t: string) => t.replace(/\b\w/g, (c: string) => c.toUpperCase()));
      lines.push(`- Tags: ${display.join(', ')}`);
    }
  } catch { /* ignore */ }

  // Build auto-context: category first, then tags alphabetically
  const contextParts: string[] = [];
  const catContext = autoContext.find(ac => ac.type === 'category' && ac.key === ticket.category);
  if (catContext) contextParts.push(catContext.text);
  const tagContexts = autoContext
    .filter(ac => ac.type === 'tag' && ticketTags.some(t => t.toLowerCase() === ac.key.toLowerCase()))
    .sort((a, b) => a.key.localeCompare(b.key));
  for (const tc of tagContexts) contextParts.push(tc.text);

  const fullDetails = contextParts.length > 0
    ? (contextParts.join('\n\n') + (ticket.details.trim() ? '\n\n' + ticket.details : ''))
    : ticket.details;

  if (fullDetails.trim()) {
    const detailLines = fullDetails.split('\n');
    lines.push(`- Details: ${detailLines[0]}`);
    for (let i = 1; i < detailLines.length; i++) {
      lines.push(`  ${detailLines[i]}`);
    }
  }

  const notes = parseTicketNotes(ticket.notes);
  if (notes.length > 0) {
    lines.push(`- Notes:`);
    for (const note of notes) {
      const timestamp = note.created_at ? ` (${new Date(note.created_at).toLocaleString()})` : '';
      lines.push(`  - ${note.text}${timestamp}`);
    }
  }

  if (attachments.length > 0) {
    lines.push(`- Attachments:`);
    for (const att of attachments) {
      lines.push(`  - ${att.stored_path}`);
    }
  }

  return lines.join('\n');
}

async function loadAutoContext(): Promise<AutoContextEntry[]> {
  try {
    const settings = await getSettings();
    if (settings.auto_context !== '') {
      const parsed: unknown = JSON.parse(settings.auto_context);
      if (Array.isArray(parsed)) return parsed as AutoContextEntry[];
    }
  } catch { /* ignore */ }
  return [];
}

async function formatCategoryDescriptions(usedCategories: Set<string>): Promise<string> {
  const allCategories = await getCategories();
  const descMap = Object.fromEntries(allCategories.map(c => [c.id, c.description]));
  const lines: string[] = ['Ticket Types:'];
  for (const cat of usedCategories) {
    lines.push(`- ${cat} - ${descMap[cat] || cat}`);
  }
  return lines.join('\n');
}

async function syncWorklist(): Promise<void> {
  try {
    const tickets = await getTickets({ up_next: true, sort_by: 'priority', sort_dir: 'asc' });
    const categories = new Set<string>();

    const sections: string[] = [];
    sections.push('# Hot Sheet - Up Next');
    sections.push('');
    sections.push('These are the current priority work items. Complete them in order of priority, where reasonable.');
    sections.push('');
    sections.push('## Workflow');
    sections.push('');
    const settings = readFileSettings(dataDir);
    const secret = settings.secret ?? '';
    const secretHeader = secret ? ` -H "X-Hotsheet-Secret: ${secret}"` : '';

    sections.push(`The Hot Sheet API is available at http://localhost:${port}/api. **You MUST update ticket status** as you work — this is required, not optional.`);
    sections.push('');
    sections.push('- **BEFORE starting work on a ticket**, set its status to "started":');
    sections.push(`  \`curl -s -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json"${secretHeader} -d '{"status": "started"}'\``);
    sections.push('');
    sections.push('- **AFTER completing work on a ticket**, set its status to "completed" and **include notes** describing what was done:');
    sections.push(`  \`curl -s -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json"${secretHeader} -d '{"status": "completed", "notes": "Describe the specific changes made"}'\``);
    sections.push('');
    sections.push('**IMPORTANT:**');
    sections.push('- Update status for EVERY ticket — "started" when you begin, "completed" when you finish.');
    sections.push('- The "notes" field is REQUIRED when completing a ticket. Describe the specific work done.');
    sections.push('- If an API call fails (e.g. connection refused, 403 secret mismatch, or error response), **re-read `.hotsheet/settings.json`** to get the correct `port` and `secret` values — you may be connecting to the wrong Hot Sheet instance. Log a visible warning to the user and continue your work. Do NOT silently skip status updates.');
    sections.push('- Do NOT set tickets to "verified" — that status is reserved for human review.');
    sections.push('');
    sections.push('## Creating Tickets');
    sections.push('');
    sections.push('You can create new tickets directly via the API. Use this strategically to:');
    sections.push('- Break up complex tasks into smaller, trackable sub-tickets');
    sections.push('- Flag implementation decisions that need human review');
    sections.push('- Record bugs or issues discovered while working');
    sections.push('- Create follow-up tasks for items outside the current scope');
    sections.push('');
    sections.push('To create a ticket:');
    const allCats = await getCategories();
    const catIds = allCats.map(c => c.id).join('|');
    sections.push(`  \`curl -s -X POST http://localhost:${port}/api/tickets -H "Content-Type: application/json"${secretHeader} -d '{"title": "Title", "defaults": {"category": "${catIds}", "up_next": false}}'\``);
    sections.push('');
    sections.push('You can also include `"details"` in the defaults object for longer descriptions.');
    sections.push('Set `up_next: true` only for items that should be prioritized immediately.');
    sections.push('');

    if (tickets.length === 0) {
      // Check if auto-order is enabled (default: true)
      const dbSettings = await getSettings();
      const autoOrder = dbSettings.auto_order !== 'false';
      if (autoOrder) {
        sections.push('## Auto-Prioritize');
        sections.push('');
        sections.push('No items are in the Up Next list, but **auto-prioritize is enabled**. Before doing anything else:');
        sections.push('');
        sections.push('1. Read `.hotsheet/open-tickets.md` to see all open tickets.');
        sections.push('2. Evaluate them by priority, urgency, and dependencies.');
        sections.push('3. Choose the most important ticket(s) to work on next.');
        sections.push(`4. Mark them as Up Next: \`curl -s -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json"${secretHeader} -d '{"up_next": true}'\``);
        sections.push('5. Then work through them as normal (set status to "started", implement, set to "completed" with notes).');
        sections.push('');
        sections.push('If there are no open tickets at all, there is nothing to do.');
      } else {
        sections.push('No items in the Up Next list.');
      }
    } else {
      const autoContext = await loadAutoContext();
      for (const ticket of tickets) {
        categories.add(ticket.category);
        sections.push('---');
        sections.push('');
        const formatted = await formatTicket(ticket, autoContext);
        sections.push(formatted);
        sections.push('');
      }

      sections.push('---');
      sections.push('');
      sections.push(await formatCategoryDescriptions(categories));
    }

    sections.push('');
    writeFileSync(join(dataDir, 'worklist.md'), sections.join('\n'), 'utf-8');
  } catch (err) {
    console.error('Failed to sync worklist.md:', err);
  }
}

async function syncOpenTickets(): Promise<void> {
  try {
    const tickets = await getTickets({ status: 'open', sort_by: 'priority', sort_dir: 'asc' });
    const categories = new Set<string>();

    const sections: string[] = [];
    sections.push('# Hot Sheet - Open Tickets');
    sections.push('');
    sections.push(`Total: ${tickets.length} open ticket(s)`);
    sections.push('');

    // Group by status
    const started = tickets.filter(t => t.status === 'started');
    const notStarted = tickets.filter(t => t.status === 'not_started');
    const autoContext = await loadAutoContext();

    if (started.length > 0) {
      sections.push(`## Started (${started.length})`);
      sections.push('');
      for (const ticket of started) {
        categories.add(ticket.category);
        const formatted = await formatTicket(ticket, autoContext);
        sections.push(formatted);
        sections.push('');
      }
    }

    if (notStarted.length > 0) {
      sections.push(`## Not Started (${notStarted.length})`);
      sections.push('');
      for (const ticket of notStarted) {
        categories.add(ticket.category);
        const formatted = await formatTicket(ticket, autoContext);
        sections.push(formatted);
        sections.push('');
      }
    }

    if (tickets.length === 0) {
      sections.push('No open tickets.');
    } else {
      sections.push('---');
      sections.push('');
      sections.push(await formatCategoryDescriptions(categories));
    }

    sections.push('');
    writeFileSync(join(dataDir, 'open-tickets.md'), sections.join('\n'), 'utf-8');
  } catch (err) {
    console.error('Failed to sync open-tickets.md:', err);
  }
}
