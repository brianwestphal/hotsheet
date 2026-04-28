import { Hono } from 'hono';

import { addLogEntry, clearLog, getLogCount, getLogEntries } from '../db/queries.js';
import type { AppEnv } from '../types.js';

export const commandLogRoutes = new Hono<AppEnv>();

const TERMINAL_PROMPT_EVENT_TYPE = 'terminal_prompt_auto_allow';
const SUMMARY_MAX_LEN = 200;
const DETAIL_MAX_LEN = 4000;
const PARSER_ID_MAX_LEN = 64;

interface TerminalPromptAuditBody {
  parser_id?: unknown;
  question?: unknown;
  choice_label?: unknown;
  rule_id?: unknown;
}

commandLogRoutes.get('/command-log', async (c) => {
  const url = new URL(c.req.url);
  const limit = Math.max(1, Math.min(1000, parseInt(url.searchParams.get('limit') ?? '100', 10) || 100));
  const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
  const eventType = url.searchParams.get('event_type') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;
  const entries = await getLogEntries({ limit, offset, eventType, search });
  return c.json(entries);
});

commandLogRoutes.delete('/command-log', async (c) => {
  await clearLog();
  return c.json({ ok: true });
});

commandLogRoutes.get('/command-log/count', async (c) => {
  const url = new URL(c.req.url);
  const eventType = url.searchParams.get('event_type') ?? undefined;
  const search = url.searchParams.get('search') ?? undefined;
  const count = await getLogCount({ eventType, search });
  return c.json({ count });
});

/**
 * HS-7987 — terminal-prompt audit endpoint. Posted by the client whenever
 * the §52 detector auto-allows a parsed prompt against a configured
 * `terminal_prompt_allow_rules` entry. Mirrors §47.4.2's audit-trail
 * pattern (`Permission: <tool> — Auto-allowed (rule <id>)`) but lives in
 * a separate event_type so the Commands Log can filter by it.
 *
 * Bounded inputs to prevent log-table abuse from a malicious client.
 */
commandLogRoutes.post('/terminal-prompt/audit', async (c) => {
  let body: TerminalPromptAuditBody;
  try { body = await c.req.json<TerminalPromptAuditBody>(); }
  catch { return c.json({ error: 'invalid_json' }, 400); }

  const parserId = typeof body.parser_id === 'string' ? body.parser_id.slice(0, PARSER_ID_MAX_LEN) : '';
  const question = typeof body.question === 'string' ? body.question : '';
  const choiceLabel = typeof body.choice_label === 'string' ? body.choice_label : '';
  const ruleId = typeof body.rule_id === 'string' ? body.rule_id.slice(0, PARSER_ID_MAX_LEN) : '';

  if (parserId === '') return c.json({ error: 'missing_parser_id' }, 400);
  if (ruleId === '') return c.json({ error: 'missing_rule_id' }, 400);

  const summary = `Terminal prompt: ${parserId} → ${choiceLabel.slice(0, 80)} — Auto-allowed (rule ${ruleId})`.slice(0, SUMMARY_MAX_LEN);
  const detail = `Question: ${question}\nChoice: ${choiceLabel}\nParser: ${parserId}\nRule: ${ruleId}`.slice(0, DETAIL_MAX_LEN);

  const entry = await addLogEntry(TERMINAL_PROMPT_EVENT_TYPE, 'incoming', summary, detail);
  return c.json({ ok: true, id: entry.id });
});
