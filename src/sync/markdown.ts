import { writeFileSync } from 'fs';
import { join } from 'path';

import { runWithDataDir } from '../db/connection.js';
import { parseNotes } from '../db/notes.js';
import { getAttachments, getCategories, getSettings, getTickets } from '../db/queries.js';
import { scheduleSnapshot } from '../db/snapshot.js';
import { instrumentAsync } from '../diagnostics/freezeLogger.js';
import { readFileSettings } from '../file-settings.js';
// HS-8558 — debounce intervals live in `src/limits.ts`. Aliased here
// to keep the local call sites readable.
import { OPEN_TICKETS_SYNC_DEBOUNCE_MS as OPEN_TICKETS_DEBOUNCE, WORKLIST_SYNC_DEBOUNCE_MS as WORKLIST_DEBOUNCE } from '../limits.js';
import { getBackgroundScheduler, PRIORITY } from '../scheduler/backgroundScheduler.js';
// HS-8671 — zod-validated DB-JSON parsing (drops the blind `as` casts).
import { AutoContextArraySchema, type AutoContextEntry, parseJsonOrNull, TagsArraySchema } from '../schemas.js';
import { getProjectSecret } from '../secret-file.js';
import type { Ticket } from '../types.js';

interface SyncState {
  dataDir: string;
  port: number;
  worklistTimeout: ReturnType<typeof setTimeout> | null;
  openTicketsTimeout: ReturnType<typeof setTimeout> | null;
}

// Per-dataDir sync state
const syncStates = new Map<string, SyncState>();

// The first registered dataDir, used as default for backward compatibility
let defaultDataDir: string | null = null;

export function initMarkdownSync(dir: string, serverPort: number) {
  if (defaultDataDir === null) {
    defaultDataDir = dir;
  }
  syncStates.set(dir, {
    dataDir: dir,
    port: serverPort,
    worklistTimeout: null,
    openTicketsTimeout: null,
  });
}

function resolveState(dir?: string): SyncState | undefined {
  if (dir !== undefined) return syncStates.get(dir);
  if (defaultDataDir !== null) return syncStates.get(defaultDataDir);
  return undefined;
}

export function scheduleWorklistSync(dir?: string) {
  const state = resolveState(dir);
  if (!state) return;
  if (state.worklistTimeout) clearTimeout(state.worklistTimeout);
  state.worklistTimeout = setTimeout(() => {
    state.worklistTimeout = null;
    // Run with the correct project's DB context (sync runs outside HTTP request scope).
    // HS-8360 — instrument so freeze.log attributes any stall to this exact pass
    // instead of leaving it in the anonymous server-heartbeat bucket. Markdown
    // sync fires on every ticket mutation (500 ms debounce) and iterates every
    // Up Next ticket through `formatTicket` + auto-context lookup.
    // HS-8724 — submit through the central scheduler (deferrable: a derived
    // markdown export is safe to hold a beat under load; coalesced per project).
    void getBackgroundScheduler().submit({
      key: `markdown-worklist:${state.dataDir}`,
      priority: PRIORITY.MARKDOWN_SYNC,
      projectKey: state.dataDir,
      deferUnderLag: true,
      run: () => runWithDataDir(state.dataDir, () => instrumentAsync(state.dataDir, 'markdown.syncWorklist', () => syncWorklist(state))),
    });
  }, WORKLIST_DEBOUNCE);
}

export function scheduleOpenTicketsSync(dir?: string) {
  const state = resolveState(dir);
  if (!state) return;
  if (state.openTicketsTimeout) clearTimeout(state.openTicketsTimeout);
  state.openTicketsTimeout = setTimeout(() => {
    state.openTicketsTimeout = null;
    // HS-8360 — instrument; the open-tickets sync iterates every open ticket
    // (potentially hundreds) through `formatTicket` so it's a likely culprit on
    // projects with large open-ticket sets. 5 s debounce means it fires less
    // frequently than worklist sync but each pass does more work.
    // HS-8724 — submit through the central scheduler (deferrable + coalesced).
    void getBackgroundScheduler().submit({
      key: `markdown-opentickets:${state.dataDir}`,
      priority: PRIORITY.MARKDOWN_SYNC,
      projectKey: state.dataDir,
      deferUnderLag: true,
      run: () => runWithDataDir(state.dataDir, () => instrumentAsync(state.dataDir, 'markdown.syncOpenTickets', () => syncOpenTickets(state))),
    });
  }, OPEN_TICKETS_DEBOUNCE);
}

export function scheduleAllSync(dir?: string) {
  scheduleWorklistSync(dir);
  scheduleOpenTicketsSync(dir);
  // HS-8586 — every ticket mutation that schedules a markdown sync also
  // schedules a debounced DB snapshot (Snapshot Protection, §73). No-op
  // when `db_snapshot_protection` is off for the project.
  scheduleSnapshot(dir);
}

/** Flush any pending debounced syncs immediately. Call before triggering Claude
 *  so the worklist/open-tickets files are up to date when the AI reads them. */
export async function flushPendingSyncs(dir?: string): Promise<void> {
  const state = resolveState(dir);
  if (!state) return;
  const promises: Promise<void>[] = [];
  if (state.worklistTimeout) {
    clearTimeout(state.worklistTimeout);
    state.worklistTimeout = null;
    // HS-8360 — same instrumentation as the scheduled path so the flush path
    // is also visible in freeze.log if it stalls.
    promises.push(runWithDataDir(state.dataDir, () => instrumentAsync(state.dataDir, 'markdown.syncWorklist:flush', () => syncWorklist(state))));
  }
  if (state.openTicketsTimeout) {
    clearTimeout(state.openTicketsTimeout);
    state.openTicketsTimeout = null;
    promises.push(runWithDataDir(state.dataDir, () => instrumentAsync(state.dataDir, 'markdown.syncOpenTickets:flush', () => syncOpenTickets(state))));
  }
  await Promise.all(promises);
}

/** Get the sync state for a given dataDir. Used by ProjectContext. */
export function getSyncState(dir: string): { worklistTimeout: ReturnType<typeof setTimeout> | null; openTicketsTimeout: ReturnType<typeof setTimeout> | null } | undefined {
  return syncStates.get(dir);
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
  const ticketTags: string[] = parseJsonOrNull(TagsArraySchema, ticket.tags) ?? [];
  if (ticketTags.length > 0) {
    const display = ticketTags.map(t => t.replace(/\b\w/g, c => c.toUpperCase()));
    lines.push(`- Tags: ${display.join(', ')}`);
  }

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

  const notes = parseNotes(ticket.notes);
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
  const settings = await getSettings();
  return parseJsonOrNull(AutoContextArraySchema, settings.auto_context) ?? [];
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

/**
 * HS-8917 — render the optional per-project worklist preamble (the
 * `worklist_preamble` file-setting). Returns `[]` when unset/blank so nothing is
 * injected; otherwise a `## Project Notes` heading + the verbatim (trimmed) text.
 * Pure + exported for unit testing. Tolerant of a non-string stored value.
 */
export function buildPreambleSection(preamble: unknown): string[] {
  const text = typeof preamble === 'string' ? preamble.trim() : '';
  if (text === '') return [];
  return ['## Project Notes', '', text, ''];
}

async function buildWorkflowInstructions(port: number, secretHeader: string): Promise<string[]> {
  const sections: string[] = [];
  sections.push('## Workflow');
  sections.push('');
  sections.push(`The Hot Sheet API is available at http://localhost:${port}/api. **You MUST update ticket status** as you work — this is required, not optional.`);
  sections.push('');
  // HS-8348 — Phase 3 two-form layout. MCP tools listed first (preferred
  // when the Claude Channel is connected), curl form right below as the
  // universal fallback for non-Claude AI agents and human terminal callers.
  sections.push('**MCP tools available.** When the Claude Channel is connected, the `hotsheet_*` MCP tools (14 tools — see the per-operation forms below) are preferred over the curl commands — schema-validated, project-scoped, and cheaper in tokens. The curl commands stay supported as the universal fallback.');
  sections.push('');
  sections.push('- **BEFORE starting work on a ticket**, set its status to "started":');
  sections.push('');
  sections.push('  **MCP tool (preferred when the channel is connected):**');
  sections.push('  Call the `hotsheet_update_ticket` tool with `{ "id": <id>, "status": "started" }`.');
  sections.push('');
  sections.push('  **Fallback (curl):**');
  sections.push(`  \`curl -s -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json"${secretHeader} -d '{"status": "started"}'\``);
  sections.push('');
  sections.push('- **AFTER completing work on a ticket**, set its status to "completed" and **include notes** describing what was done:');
  sections.push('');
  sections.push('  **MCP tool (preferred when the channel is connected):**');
  sections.push('  Call the `hotsheet_update_ticket` tool with `{ "id": <id>, "status": "completed", "notes": "Describe the specific changes made" }`.');
  sections.push('');
  sections.push('  **Fallback (curl):**');
  sections.push(`  \`curl -s -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json"${secretHeader} -d '{"status": "completed", "notes": "Describe the specific changes made"}'\``);
  sections.push('');
  sections.push('**IMPORTANT:**');
  sections.push('- Update status for EVERY ticket — "started" when you begin, "completed" when you finish.');
  sections.push('- The "notes" field is REQUIRED when completing a ticket. Describe the specific work done.');
  sections.push('- If an API call fails (e.g. connection refused, 403 secret mismatch, or error response), **re-read `.hotsheet/settings.json`** to get the correct `port` and `secret` values — you may be connecting to the wrong Hot Sheet instance. Log a visible warning to the user and continue your work. Do NOT silently skip status updates.');
  sections.push('- Do NOT set tickets to "verified" — that status is reserved for human review.');
  sections.push('- Do NOT use the API to read or list tickets (e.g., GET /api/tickets). Always read this worklist file for current work items. The API is only for updating ticket status and creating new tickets.');
  sections.push('');
  sections.push('### Note formatting');
  sections.push('');
  sections.push('Notes render as **Markdown** in the Hot Sheet UI. Unformatted walls of text are hard for the user to scan — use real Markdown structure:');
  sections.push('');
  sections.push('- **Paragraph breaks** between distinct ideas (a blank line in the JSON string — `\\n\\n`).');
  sections.push('- **Bullet lists** for enumerations of changes, files touched, or test cases.');
  sections.push('- **Bold** (`**word**`) for the things a reader scanning the note needs to spot first (root-cause line, ticket id, key file path).');
  sections.push('- **Inline code** (`` `name` ``) for file paths, function names, identifiers, command snippets, settings keys, etc.');
  sections.push('- **Headings** (`### Section`) when the note has more than one logical section.');
  sections.push('');
  sections.push('When a completion note runs longer than ~6 lines, lead with a **TL;DR:** line summarising the change in one sentence, then expand below with the details (root cause, fix, tests, follow-ups). The TL;DR is the only thing many readers skim, so make it count.');
  sections.push('');
  sections.push('Example shape for a non-trivial fix:');
  sections.push('');
  sections.push('```');
  sections.push('**TL;DR:** Fixed quit prompt firing for idle login zsh — `ps -o comm` returned `/bin/zsh` not `zsh`, so the exempt-list lookup missed.');
  sections.push('');
  sections.push('### Root cause');
  sections.push('macOS `ps -o comm` emits the executable\'s full path …');
  sections.push('');
  sections.push('### Fix');
  sections.push('- New `normalizeComm()` helper in `src/terminals/processInspect.ts`');
  sections.push('- Applied in `parsePsOutput` so every downstream check sees a basename');
  sections.push('');
  sections.push('### Tests');
  sections.push('10 new tests covering the path / dash / .exe / idempotence cases plus an end-to-end assertion …');
  sections.push('```');
  sections.push('');
  sections.push('Embed Markdown in the JSON `notes` field by escaping newlines as `\\n` in the curl payload (e.g. `-d \'{"notes": "**TL;DR:** …\\n\\n### Root cause\\n…"}\'`). When the note is more than a few lines long, write the JSON to a temp file and use `--data-binary @/tmp/notes.json` instead of inlining — that avoids shell-escaping pain on backticks, dollar signs, and quotes.');
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
  sections.push('');
  sections.push('  **MCP tool (preferred when the channel is connected):**');
  sections.push(`  Call the \`hotsheet_create_ticket\` tool with \`{ "title": "Title", "category": "${catIds}", "up_next": false }\`. The \`details\`, \`priority\`, \`tags\` keys are also accepted; only \`title\` is required.`);
  sections.push('');
  sections.push('  **Fallback (curl):**');
  sections.push(`  \`curl -s -X POST http://localhost:${port}/api/tickets -H "Content-Type: application/json"${secretHeader} -d '{"title": "Title", "defaults": {"category": "${catIds}", "up_next": false}}'\``);
  sections.push('');
  sections.push('You can also include `"details"` in the defaults object (curl) or as a top-level field (MCP) for longer descriptions.');
  sections.push('Set `up_next: true` only for items that should be prioritized immediately.');
  sections.push('');

  // Attachment upload instructions
  sections.push('## Uploading Attachments');
  sections.push('');
  sections.push('You can attach files to tickets:');
  sections.push('');
  sections.push('  **MCP tool (preferred when the channel is connected):**');
  sections.push('  Call the `hotsheet_add_attachment` tool with `{ "ticket_id": <id>, "path": "/absolute/path/to/file.png" }`. The tool reads the file from disk and posts multipart on your behalf — no shell escaping needed.');
  sections.push('');
  sections.push('  **Fallback (curl):**');
  sections.push(`  \`curl -s -X POST http://localhost:${port}/api/tickets/{id}/attachments${secretHeader} -F "file=@/path/to/file.png"\``);
  sections.push('');
  sections.push('Do NOT set `Content-Type: application/json` on the curl form — curl sets the multipart boundary automatically with `-F`.');
  sections.push('');

  // Feedback instructions
  sections.push('## Requesting User Feedback');
  sections.push('');
  sections.push('When you need input from the user before continuing, add a note where the **entire note text begins** with one of these exact prefixes:');
  sections.push('');
  sections.push('- **Standard feedback**: `FEEDBACK NEEDED: Your question here`');
  sections.push('');
  sections.push('  **MCP tool (preferred when the channel is connected):**');
  sections.push('  Call the `hotsheet_request_feedback` tool with `{ "ticket_id": <id>, "question": "Your question here" }`. The tool prepends the `FEEDBACK NEEDED:` prefix automatically.');
  sections.push('');
  sections.push('  **Fallback (curl):**');
  sections.push(`  \`curl -s -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json"${secretHeader} -d '{"notes": "FEEDBACK NEEDED: Your question here"}'\``);
  sections.push('');
  sections.push('- **Urgent feedback** (auto-selects the ticket in the UI): `IMMEDIATE FEEDBACK NEEDED: Your question here`');
  sections.push('');
  sections.push('  **MCP tool (preferred when the channel is connected):**');
  sections.push('  Call the `hotsheet_request_feedback` tool with `{ "ticket_id": <id>, "question": "Your urgent question", "urgent": true }`. The tool prepends the `IMMEDIATE FEEDBACK NEEDED:` prefix automatically.');
  sections.push('');
  sections.push('  **Fallback (curl):**');
  sections.push(`  \`curl -s -X PATCH http://localhost:${port}/api/tickets/{id} -H "Content-Type: application/json"${secretHeader} -d '{"notes": "IMMEDIATE FEEDBACK NEEDED: Your urgent question"}'\``);
  sections.push('');
  sections.push('**IMPORTANT:** The prefix must be the very first characters of the note — do not add any text before it. The note text sent in the `"notes"` field must start with `FEEDBACK NEEDED:` or `IMMEDIATE FEEDBACK NEEDED:` exactly.');
  sections.push('');
  sections.push('After adding a feedback note, signal done and wait to be re-triggered. The user will see a dialog prompting them to respond. When they submit feedback, you will be re-triggered with a message indicating the ticket was updated.');
  sections.push('');
  sections.push('Only the most recent note is checked for feedback prefixes. Once the user responds (or clicks "No Response Needed"), the feedback state clears automatically.');
  sections.push('');
  return sections;
}

async function buildAutoPrioritizeSection(port: number, secretHeader: string): Promise<string[]> {
  const dbSettings = await getSettings();
  const autoOrder = dbSettings.auto_order !== 'false';
  if (!autoOrder) {
    return ['No items in the Up Next list.'];
  }

  const sections: string[] = [];
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
  return sections;
}

async function syncWorklist(state: SyncState): Promise<void> {
  const { dataDir, port } = state;
  try {
    const tickets = await getTickets({ up_next: true, sort_by: 'priority', sort_dir: 'asc' });
    const categories = new Set<string>();

    const sections: string[] = [];
    sections.push('# Hot Sheet - Up Next');
    sections.push('');
    sections.push('These are the current priority work items. Complete them in order of priority, where reasonable.');
    sections.push('');
    const settings = readFileSettings(dataDir);
    const secret = getProjectSecret(dataDir); // HS-8999 — sidecar secret
    const secretHeader = secret ? ` -H "X-Hotsheet-Secret: ${secret}"` : '';

    // HS-8917 — optional per-project preamble, injected near the top BEFORE the
    // protocol sections (Workflow / Creating Tickets / …) so user customization
    // can't break the channel/skill/MCP contract. See docs/6-markdown-sync.md.
    sections.push(...buildPreambleSection(settings.worklist_preamble));

    sections.push(...await buildWorkflowInstructions(port, secretHeader));

    if (tickets.length === 0) {
      sections.push(...await buildAutoPrioritizeSection(port, secretHeader));
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

async function syncOpenTickets(state: SyncState): Promise<void> {
  const { dataDir } = state;
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
