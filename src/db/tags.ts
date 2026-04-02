import { getDb } from './connection.js';

// --- Tags ---

/** Normalize a tag: collapse non-alphanumeric runs to single space, lowercase, trim. */
function normalizeTag(input: string): string {
  return input.replace(/[^a-zA-Z0-9]+/g, ' ').trim().toLowerCase();
}

/** Extract bracket tags from a title, returning cleaned title and normalized tag list. */
export function extractBracketTags(input: string): { title: string; tags: string[] } {
  const tags: string[] = [];
  const cleaned = input.replace(/\[([^\]]*)\]/g, (_match, content: string) => {
    const tag = normalizeTag(content);
    if (tag && !tags.includes(tag)) tags.push(tag);
    return ' ';
  });
  const title = cleaned.replace(/\s+/g, ' ').trim();
  return { title, tags };
}

export async function getAllTags(): Promise<string[]> {
  const db = await getDb();
  const result = await db.query<{ tags: string }>(`SELECT DISTINCT tags FROM tickets WHERE tags != '[]' AND status != 'deleted'`);
  const tagSet = new Set<string>();
  for (const row of result.rows) {
    try {
      const parsed: unknown = JSON.parse(row.tags);
      if (Array.isArray(parsed)) {
        for (const tag of parsed) {
          if (typeof tag === 'string' && tag.trim()) {
            const norm = normalizeTag(tag);
            if (norm) tagSet.add(norm);
          }
        }
      }
    } catch { /* ignore bad JSON */ }
  }
  return Array.from(tagSet).sort();
}
