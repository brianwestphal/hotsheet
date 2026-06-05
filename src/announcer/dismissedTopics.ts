/**
 * §78 Announcer live mode (HS-8769) — "mark uninteresting" learn-from-skips.
 *
 * When the listener skips an entry, its title is recorded as a per-project
 * "dismissed topic". The list is injected into the generator prompt
 * (`buildSystemPrompt`) so future batches omit similar material — and is
 * editable from the Announcer settings. Stored as a JSON array string in the
 * per-project settings table under `announcer_dismissed_topics`.
 */
import { getSettings, updateSetting } from '../db/queries.js';

export const ANNOUNCER_DISMISSED_TOPICS_KEY = 'announcer_dismissed_topics';
/** Keep only the most-recent N topics so the prompt stays bounded. */
export const MAX_DISMISSED_TOPICS = 30;

function parseTopics(raw: string | undefined): string[] {
  if (raw === undefined || raw === '') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((x): x is string => typeof x === 'string');
  } catch {
    return [];
  }
}

/** Trim, drop blanks, case-insensitively dedupe, and keep the most-recent N. */
export function normalizeTopics(topics: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of topics) {
    const v = t.trim();
    if (v === '' || seen.has(v.toLowerCase())) continue;
    seen.add(v.toLowerCase());
    out.push(v);
  }
  return out.slice(-MAX_DISMISSED_TOPICS);
}

export async function getDismissedTopics(): Promise<string[]> {
  return parseTopics((await getSettings())[ANNOUNCER_DISMISSED_TOPICS_KEY]);
}

export async function setDismissedTopics(topics: readonly string[]): Promise<string[]> {
  const cleaned = normalizeTopics(topics);
  await updateSetting(ANNOUNCER_DISMISSED_TOPICS_KEY, JSON.stringify(cleaned));
  return cleaned;
}

/** Append one topic (a skipped entry's title) to the list. */
export async function addDismissedTopic(topic: string): Promise<void> {
  if (topic.trim() === '') return;
  await setDismissedTopics([...await getDismissedTopics(), topic]);
}
