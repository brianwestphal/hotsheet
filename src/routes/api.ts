import { Hono } from 'hono';

import { PLUGINS_ENABLED } from '../feature-flags.js';
import type { AppEnv } from '../types.js';
import { attachmentRoutes } from './attachments.js';
import { channelRoutes } from './channel.js';
import { commandLogRoutes } from './commandLog.js';
import { dashboardRoutes } from './dashboard.js';
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
apiRoutes.onError((err, c) => {
  if (err instanceof SyntaxError && /JSON/i.test(err.message)) {
    return c.json({ error: `Invalid JSON body: ${err.message}` }, 400);
  }
  throw err;
});

apiRoutes.route('/', ticketRoutes);
apiRoutes.route('/', attachmentRoutes);
apiRoutes.route('/', channelRoutes);
apiRoutes.route('/', commandLogRoutes);
apiRoutes.route('/', settingsRoutes);
apiRoutes.route('/', dashboardRoutes);
apiRoutes.route('/', shellRoutes);
apiRoutes.route('/terminal', terminalRoutes);
if (PLUGINS_ENABLED) apiRoutes.route('/', pluginRoutes);
