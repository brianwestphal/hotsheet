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
import * as attachments from './attachments.js';
import * as backups from './backups.js';
import * as channel from './channel.js';
import * as commandLog from './commandLog.js';
import * as dashboard from './dashboard.js';
import * as db from './db.js';
import * as diagnostics from './diagnostics.js';
import * as feedbackDrafts from './feedbackDrafts.js';
import * as git from './git.js';
import * as plugins from './plugins.js';
import * as projects from './projects.js';
import * as settings from './settings.js';
import * as shell from './shell.js';
import * as telemetry from './telemetry.js';
import * as terminal from './terminal.js';
import * as tickets from './tickets.js';

export * from './attachments.js';
export * from './backups.js';
export * from './channel.js';
export * from './commandLog.js';
export * from './dashboard.js';
export * from './db.js';
export * from './diagnostics.js';
export * from './feedbackDrafts.js';
export * from './git.js';
export * from './plugins.js';
export * from './projects.js';
export * from './settings.js';
export * from './shell.js';
export * from './telemetry.js';
export * from './terminal.js';
export * from './tickets.js';

/** Flat namespace combining every typed caller. Names are globally unique
 *  by convention. */
export const apis = {
  ...git,
  ...tickets,
  ...feedbackDrafts,
  ...terminal,
  ...telemetry,
  ...backups,
  ...db,
  ...channel,
  ...projects,
  ...plugins,
  ...attachments,
  ...settings,
  ...shell,
  ...commandLog,
  ...dashboard,
  ...diagnostics,
};
