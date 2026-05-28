/**
 * HS-8678 — `src/db/otelQueries.ts` is now a thin re-export facade. The
 * individual rollup queries + shared helpers live in `./otelRollups.ts`; the
 * composite-payload assemblers (`getDashboardPayload`, `getProjectRollupPayload`)
 * and the per-prompt / per-ticket drilldowns (`getPromptTimeline`,
 * `getPerTicketRollup`) live in `./otelDashboard.ts`. Every external caller
 * keeps importing from `./otelQueries.js` to preserve the original API
 * surface, mirroring the HS-8189 registry split pattern.
 *
 * **When adding a new query:**
 *  - Individual rollup (single SQL slice over `otel_*`) → `./otelRollups.ts`.
 *  - Composite assembler (Promise.all over multiple rollups, or a per-key
 *    drilldown like prompt/ticket) → `./otelDashboard.ts`.
 *  - Then add a re-export below if it should be visible to outside callers.
 *
 * **Internal helpers** (`buildSecretsInClause`, `buildProjectAndWindowClauses`,
 * `buildHistogramBucketCase`, the token-type SQL predicates) stay un-exported
 * in `./otelRollups.ts`. `eventNameMatchSql` is the one exception — exported
 * from rollups so `getPerTicketRollup` can use it in `./otelDashboard.ts`.
 */

export * from './otelDashboard.js';
export * from './otelRollups.js';
