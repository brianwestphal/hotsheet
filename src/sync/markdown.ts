import { writeFileSync } from 'fs';
import { join } from 'path';

import { getAttachments, getTickets } from '../db/queries.js';
import type { Ticket, TicketCategory } from '../types.js';
import { CATEGORY_DESCRIPTIONS } from '../types.js';

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
  if (!raw || raw === '') return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch { /* not JSON */ }
  if (raw.trim()) return [{ text: raw, created_at: '' }];
  return [];
}

async function formatTicket(ticket: Ticket): Promise<string> {
  const attachments = await getAttachments(ticket.id);
  const lines: string[] = [];

  lines.push(`TICKET ${ticket.ticket_number}:`);
  lines.push(`- ID: ${ticket.id}`);
  lines.push(`- Type: ${ticket.category}`);
  lines.push(`- Priority: ${ticket.priority}`);
  lines.push(`- Status: ${ticket.status.replace('_', ' ')}`);
  lines.push(`- Title: ${ticket.title}`);

  if (ticket.details.trim()) {
    const detailLines = ticket.details.split('\n');
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

function formatCategoryDescriptions(categories: Set<TicketCategory>): string {
  const lines: string[] = ['Ticket Types:'];
  for (const cat of categories) {
    lines.push(`- ${cat} - ${CATEGORY_DESCRIPTIONS[cat]}`);
  }
  return lines.join('\n');
}

async function syncWorklist(): Promise<void> {
  try {
    const tickets = await getTickets({ up_next: true, sort_by: 'priority', sort_dir: 'asc' });
    const categories = new Set<TicketCategory>();

    const sections: string[] = [];
    sections.push('# Hot Sheet - Up Next');
    sections.push('');
    sections.push('These are the current priority work items. Complete them in order of priority, where reasonable.');
    sections.push('');
    sections.push('## Workflow');
    sections.push('');
    sections.push(`The Hot Sheet API is available at http://localhost:${port}/api. Use it to update ticket status as you work:`);
    sections.push('');
    sections.push('- **When you start working on a ticket**, set its status to "started":');
    sections.push(`  \`curl -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json" -d '{"status": "started"}'\``);
    sections.push('');
    sections.push('- **When you finish working on a ticket**, set its status to "completed" and add notes describing what was done:');
    sections.push(`  \`curl -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json" -d '{"status": "completed", "notes": "Description of work completed"}'\``);
    sections.push('');
    sections.push('Do NOT set tickets to "verified" — that status is reserved for human review.');
    sections.push('');

    if (tickets.length === 0) {
      sections.push('No items in the Up Next list.');
    } else {
      for (const ticket of tickets) {
        categories.add(ticket.category);
        sections.push('---');
        sections.push('');
        const formatted = await formatTicket(ticket);
        sections.push(formatted);
        sections.push('');
      }

      sections.push('---');
      sections.push('');
      sections.push(formatCategoryDescriptions(categories));
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
    const categories = new Set<TicketCategory>();

    const sections: string[] = [];
    sections.push('# Hot Sheet - Open Tickets');
    sections.push('');
    sections.push(`Total: ${tickets.length} open ticket(s)`);
    sections.push('');

    // Group by status
    const started = tickets.filter(t => t.status === 'started');
    const notStarted = tickets.filter(t => t.status === 'not_started');

    if (started.length > 0) {
      sections.push(`## Started (${started.length})`);
      sections.push('');
      for (const ticket of started) {
        categories.add(ticket.category);
        const formatted = await formatTicket(ticket);
        sections.push(formatted);
        sections.push('');
      }
    }

    if (notStarted.length > 0) {
      sections.push(`## Not Started (${notStarted.length})`);
      sections.push('');
      for (const ticket of notStarted) {
        categories.add(ticket.category);
        const formatted = await formatTicket(ticket);
        sections.push(formatted);
        sections.push('');
      }
    }

    if (tickets.length === 0) {
      sections.push('No open tickets.');
    } else {
      sections.push('---');
      sections.push('');
      sections.push(formatCategoryDescriptions(categories));
    }

    sections.push('');
    writeFileSync(join(dataDir, 'open-tickets.md'), sections.join('\n'), 'utf-8');
  } catch (err) {
    console.error('Failed to sync open-tickets.md:', err);
  }
}
