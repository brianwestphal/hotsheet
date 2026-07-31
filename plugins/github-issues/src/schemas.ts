/**
 * HS-9523 — zod schemas for every GitHub API response this plugin reads.
 *
 * ## Why this file exists
 *
 * Every one of these responses used to be consumed as `await res.json() as T` —
 * an unchecked assertion at a wire boundary, which is the HS-8567 class: the
 * compiler is told to trust a shape that arrives from another system at runtime,
 * so an upstream change ships a crash while everything still typechecks.
 *
 * The `no-restricted-syntax` ESLint rule has flagged that pattern for a long
 * time. It never fired here because `npm run lint` only ever ran `eslint src/`,
 * so `plugins/` was outside the gate entirely (HS-9523). A sync plugin talking
 * to a third-party REST API is precisely where the rule earns its keep, and it
 * was the one place not covered.
 *
 * ## Design notes
 *
 * **Validate structure, stay permissive about values.** These schemas assert the
 * fields the plugin actually reads and their broad types. They deliberately do
 * NOT enumerate value sets — `state` is a plain string rather than an enum of
 * open/closed — because a new GitHub state should not break a sync that would
 * otherwise have worked. An over-strict schema converts a harmless upstream
 * addition into an outage, which is the opposite of the goal.
 *
 * **Unknown keys are dropped, not rejected.** zod objects strip by default.
 * GitHub sends dozens of fields per issue; requiring them to be declared would
 * make every API addition a breaking change.
 *
 * **Failures name the endpoint.** `parseGitHub` throws with the endpoint and the
 * zod issue path, so a shape change reports as "GitHub /issues response did not
 * match: labels.0.name — expected string" instead of a `TypeError` several
 * frames deeper with no indication that the network was involved.
 */

import { z } from 'zod';

/** A label is either the bare name or an object carrying it. */
export const GitHubLabelSchema = z.union([
  z.string(),
  z.object({ name: z.string() }),
]);

export const GitHubMilestoneSchema = z.object({
  number: z.number(),
  title: z.string(),
});

export const GitHubIssueSchema = z.object({
  number: z.number(),
  title: z.string(),
  body: z.string().nullish(),
  // Permissive on purpose — see the header note on value sets.
  state: z.string(),
  labels: z.array(GitHubLabelSchema).default([]),
  milestone: GitHubMilestoneSchema.nullish(),
  updated_at: z.string(),
  // Presence is the signal (an issue endpoint returns PRs too); the value is
  // never read, so its shape is deliberately unconstrained.
  pull_request: z.unknown().optional(),
});

/**
 * The response to a PATCH/update, where the plugin reads ONLY `updated_at` (to
 * advance the sync watermark — HS-8954/HS-8955).
 *
 * Deliberately narrower than `GitHubIssueSchema`: validating a full issue here
 * would reject a response for missing fields nobody looks at, turning a working
 * push into a failure. Validate what you read, not what the endpoint happens to
 * return — the same principle as the value-permissiveness note above.
 */
export const GitHubUpdatedIssueSchema = z.object({
  updated_at: z.string().nullish(),
});

export const GitHubIssueListSchema = z.array(GitHubIssueSchema);
export const GitHubMilestoneListSchema = z.array(GitHubMilestoneSchema);

export const GitHubCommentSchema = z.object({
  id: z.number(),
  body: z.string().nullish(),
  created_at: z.string(),
  updated_at: z.string(),
});

export const GitHubCommentListSchema = z.array(GitHubCommentSchema);

/** Response to creating a comment — only the id is read. */
export const GitHubCreatedCommentSchema = z.object({ id: z.number() });

/** Response to a contents-API file upload. */
export const GitHubContentsWriteSchema = z.object({
  content: z
    .object({
      download_url: z.string().nullish(),
      html_url: z.string().nullish(),
      path: z.string().nullish(),
    })
    .nullish(),
});

/** Issue fetched with the `html+json` Accept header, for the rendered body. */
export const GitHubIssueHtmlSchema = z.object({
  body_html: z.string().nullish(),
});

export type GitHubIssue = z.infer<typeof GitHubIssueSchema>;
export type GitHubMilestone = z.infer<typeof GitHubMilestoneSchema>;
export type GitHubComment = z.infer<typeof GitHubCommentSchema>;

/**
 * Read a `Response` body and validate it against `schema`.
 *
 * Replaces `await res.json() as T`. The body is typed `unknown` on the way in —
 * the whole point is that nothing downstream sees a shape that has not been
 * checked at runtime.
 *
 * Throws on mismatch rather than returning null: the callers here are sync
 * operations where silently proceeding with a half-understood payload would
 * write wrong data into the local database. A loud, endpoint-named failure is
 * recoverable; a quiet one is not.
 */
export async function parseGitHub<T>(
  schema: z.ZodType<T>,
  // Structural rather than `Response`: the plugin's tsconfig has no DOM lib, and
  // the helper only ever needs `json()`. It also makes this testable with a
  // plain object instead of constructing a real Response.
  res: { json(): Promise<unknown> },
  endpoint: string,
): Promise<T> {
  const raw: unknown = await res.json();
  const result = schema.safeParse(raw);
  if (!result.success) {
    const detail = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join('.') || '(root)'} — ${i.message}`)
      .join('; ');
    throw new Error(`GitHub ${endpoint} response did not match the expected shape: ${detail}`);
  }
  return result.data;
}

/** A ticket's `tags` column is a JSON-encoded string array. */
export const TagsArraySchema = z.array(z.string());

/**
 * HS-9523 — parse a ticket's `tags` column.
 *
 * Replaces `JSON.parse(ticket.tags || '[]')`, which produced `any` and carried a
 * dead `typeof === 'string'` branch (the field is typed `string`, so the
 * non-string arm was unreachable). Malformed JSON yields `[]` rather than
 * throwing: tags are advisory metadata, and failing a whole sync because one
 * ticket has a corrupt tags column would be a worse outcome than dropping them.
 */
export function parseTags(raw: string): string[] {
  if (raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const result = TagsArraySchema.safeParse(parsed);
  return result.success ? result.data : [];
}
