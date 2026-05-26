//
// HS-8522 — aggregated entry point for the typed API layer.
//
// Two ways to consume it:
//
//   Named import (tree-shakes cleanly):
//     import { getGitStatus } from '../api/index.js';
//     const status = await getGitStatus();
//
//   Flat namespace (the shape the ticket asked for):
//     import { apis } from '../api/index.js';
//     const status = await apis.getGitStatus();
//
// Both forms map to the same runtime functions. The flat namespace requires
// every caller name to be globally unique across resource modules — see each
// src/api/<resource>.ts for its catalog.
//
// Every Req/Resp schema + inferred type is re-exported too, so server route
// files can import a schema from here (or the specific module) and stay in
// lockstep with the client.
//
// Resource modules are added here as each domain is migrated (HS-8522
// sub-tickets). Today: git, tickets, feedbackDrafts, terminal.
//
import * as feedbackDrafts from './feedbackDrafts.js';
import * as git from './git.js';
import * as terminal from './terminal.js';
import * as tickets from './tickets.js';

export * from './feedbackDrafts.js';
export * from './git.js';
export * from './terminal.js';
export * from './tickets.js';

/** Flat namespace combining every typed caller. Names are globally unique
 *  by convention. */
export const apis = {
  ...git,
  ...tickets,
  ...feedbackDrafts,
  ...terminal,
};
