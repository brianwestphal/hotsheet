import { Hono } from 'hono';

import type { AppEnv } from '../types.js';
import { attachmentRoutes } from './attachments.js';
import { channelRoutes } from './channel.js';
import { commandLogRoutes } from './commandLog.js';
import { dashboardRoutes } from './dashboard.js';
import { settingsRoutes } from './settings.js';
import { shellRoutes } from './shell.js';
import { ticketRoutes } from './tickets.js';

export const apiRoutes = new Hono<AppEnv>();

apiRoutes.route('/', ticketRoutes);
apiRoutes.route('/', attachmentRoutes);
apiRoutes.route('/', channelRoutes);
apiRoutes.route('/', commandLogRoutes);
apiRoutes.route('/', settingsRoutes);
apiRoutes.route('/', dashboardRoutes);
apiRoutes.route('/', shellRoutes);
