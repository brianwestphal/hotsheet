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

apiRoutes.route('/', ticketRoutes);
apiRoutes.route('/', attachmentRoutes);
apiRoutes.route('/', channelRoutes);
apiRoutes.route('/', commandLogRoutes);
apiRoutes.route('/', settingsRoutes);
apiRoutes.route('/', dashboardRoutes);
apiRoutes.route('/', shellRoutes);
apiRoutes.route('/terminal', terminalRoutes);
if (PLUGINS_ENABLED) apiRoutes.route('/', pluginRoutes);
