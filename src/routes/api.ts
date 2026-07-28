import type { ErrorHandler } from 'hono';
import { Hono } from 'hono';

import { isClusterStorageFailure } from '../db/storageFailure.js';
import { PLUGINS_ENABLED } from '../feature-flags.js';
import type { AppEnv } from '../types.js';
import { getErrorMessage } from '../utils/errorMessage.js';
import { aiInstructionsRoutes } from './aiInstructions.js';
import { attachmentRoutes } from './attachments.js';
import { channelRoutes } from './channel.js';
import { commandLogRoutes } from './commandLog.js';
import { dashboardRoutes } from './dashboard.js';
import { devicesRoutes } from './devices.js';
import { diagnosticsRoutes } from './diagnostics.js';
import { pluginRoutes } from './plugins.js';
import { settingsRoutes } from './settings.js';
import { shellRoutes } from './shell.js';
import { terminalRoutes } from './terminal.js';
import { ticketRoutes } from './tickets.js';

export const apiRoutes = new Hono<AppEnv>();

// Malformed JSON bodies throw SyntaxError from c.req.json() inside Hono.
// Without this handler, they surface as an unhandled 500 with a full stack
// trace in the server log (HS-6700). Convert them to a clean 400 so the
// client sees a useful error and the log stays readable.
//
// HS-9453 — everything ELSE used to `throw err` here, straight into Hono's default
// handler, which answers with a bodyless 500. `parseErrorBody` on the client finds
// no `error` field and falls back to the literal string "Server returned 500", so
// the user gets a popup that names neither what broke nor what they were doing.
// Now the real message crosses the wire, plus a short `ref` that also goes into the
// server log so a screenshot can be matched to a stack trace.
export const apiErrorHandler: ErrorHandler<AppEnv> = (err, c) => {
  if (err instanceof SyntaxError && /JSON/i.test(err.message)) {
    return c.json({ error: `Invalid JSON body: ${err.message}` }, 400);
  }
  const ref = Math.random().toString(36).slice(2, 8);
  // The STACK stays server-side; only the message is sent. Enough for the user to
  // say what happened, without shipping internals to a (possibly remote, §94) client.
  console.error(`[api error ${ref}] ${c.req.method} ${c.req.path} —`, err);
  // HS-9460 — the storage-corruption class (docs/73 §73.5.1) fails EVERY write
  // until the process restarts, so `xlog flush request 0/3BA18488 is not
  // satisfied --- flushed only to 0/3BA175E0` is what the user would otherwise
  // see on every action. Replace it with the one thing they can act on. The
  // cluster is already marked for recovery by `handleLiveStorageFailure`, so the
  // restart is not just a suggestion — it heals.
  if (isClusterStorageFailure(err)) {
    return c.json({
      error: 'The database stopped accepting writes (storage corruption). Restart Hot Sheet — it will restore this project from the newest snapshot automatically.',
      code: 'database_needs_recovery',
      ref,
    }, 500);
  }
  return c.json({ error: getErrorMessage(err), code: 'internal_error', ref }, 500);
};

apiRoutes.onError(apiErrorHandler);

apiRoutes.route('/', ticketRoutes);
apiRoutes.route('/', attachmentRoutes);
apiRoutes.route('/', channelRoutes);
apiRoutes.route('/', commandLogRoutes);
apiRoutes.route('/', settingsRoutes);
apiRoutes.route('/', dashboardRoutes);
apiRoutes.route('/', shellRoutes);
apiRoutes.route('/', diagnosticsRoutes);
apiRoutes.route('/', devicesRoutes);
apiRoutes.route('/', aiInstructionsRoutes);
apiRoutes.route('/terminal', terminalRoutes);
if (PLUGINS_ENABLED) apiRoutes.route('/', pluginRoutes);
