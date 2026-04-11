// GitHub Issues plugin for Hot Sheet
// Syncs tickets bidirectionally with GitHub Issues via the REST API.

import type { FieldMap, PluginContext, PluginUIElement, RemoteChange, RemoteComment, RemoteTicketFields, Ticket, TicketingBackend } from './types.js';

const API_BASE = 'https://api.github.com';

interface FieldMapPair {
  toRemote: Record<string, string>;
  toLocal: Record<string, string>;
}

// Default field mappings
const DEFAULT_CATEGORY_MAP: FieldMapPair = {
  toRemote: {
    issue: 'category:issue',
    bug: 'category:bug',
    feature: 'category:feature',
    requirement_change: 'category:requirement-change',
    task: 'category:task',
    investigation: 'category:investigation',
  },
  toLocal: {
    'category:issue': 'issue',
    'category:bug': 'bug',
    'category:feature': 'feature',
    'category:requirement-change': 'requirement_change',
    'category:task': 'task',
    'category:investigation': 'investigation',
  },
};

const DEFAULT_PRIORITY_MAP: FieldMapPair = {
  toRemote: {
    highest: 'priority:highest',
    high: 'priority:high',
    default: 'priority:default',
    low: 'priority:low',
    lowest: 'priority:lowest',
  },
  toLocal: {
    'priority:highest': 'highest',
    'priority:high': 'high',
    'priority:default': 'default',
    'priority:low': 'low',
    'priority:lowest': 'lowest',
  },
};

const DEFAULT_STATUS_LABEL_MAP: FieldMapPair = {
  toRemote: {
    not_started: 'status:not-started',
    started: 'status:started',
    completed: 'status:completed',
    verified: 'status:verified',
  },
  toLocal: {
    'status:not-started': 'not_started',
    'status:started': 'started',
    'status:completed': 'completed',
    'status:verified': 'verified',
  },
};

// GitHub open/closed state mapping (used alongside labels)
const GITHUB_STATE_FOR_STATUS: Record<string, 'open' | 'closed'> = {
  not_started: 'open',
  started: 'open',
  completed: 'closed',
  verified: 'closed',
};

interface GitHubLabel {
  name: string;
}

interface GitHubMilestone {
  number: number;
  title: string;
}

interface GitHubIssue {
  number: number;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: (string | GitHubLabel)[];
  milestone: GitHubMilestone | null;
  updated_at: string;
  pull_request?: unknown;
}

let _context: PluginContext | null = null;
let _backend: TicketingBackend | null = null;

export async function activate(context: PluginContext): Promise<TicketingBackend> {
  _context = context;
  const token = await context.getSetting('token');
  const owner = await context.getSetting('owner');
  const repo = await context.getSetting('repo');

  const catPrefix = (await context.getSetting('label_prefix_category')) || 'category:';
  const priPrefix = (await context.getSetting('label_prefix_priority')) || 'priority:';
  const statusPrefix = (await context.getSetting('label_prefix_status')) || 'status:';
  const upNextLabel = (await context.getSetting('up_next_label')) || 'up-next';
  const milestonePrefix = (await context.getSetting('milestone_tag_prefix')) || 'milestone:';
  const attachmentRepo = await context.getSetting('attachment_repo');
  const attachmentFolder = (await context.getSetting('attachment_folder')) || 'hotsheet-attachments';
  const attachmentBranch = (await context.getSetting('attachment_branch')) || 'main';

  // Parse attachment repo into owner/repo
  const attachmentRepoParts = attachmentRepo?.split('/');
  const attOwner = attachmentRepoParts?.[0] || '';
  const attRepo = attachmentRepoParts?.[1] || '';
  const canUploadAttachments = attOwner !== '' && attRepo !== '';

  const syncDirection = (await context.getSetting('sync_direction')) || 'bidirectional';
  const filterLabels = ((await context.getSetting('filter_labels')) || '')
    .split(',')
    .map(l => l.trim())
    .filter(Boolean);

  // Register UI elements
  const GITHUB_ICON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>';
  context.registerUI([
    {
      id: 'sync-button',
      type: 'button',
      location: 'toolbar',
      icon: GITHUB_ICON,
      title: 'Sync with GitHub',
      action: 'sync',
    } as PluginUIElement,
  ]);

  const autoSyncNew = (await context.getSetting('auto_sync_new')) === 'true';

  const categoryMap = buildPrefixMap(DEFAULT_CATEGORY_MAP, 'category:', catPrefix);
  const priorityMap = buildPrefixMap(DEFAULT_PRIORITY_MAP, 'priority:', priPrefix);
  const statusLabelMap = buildPrefixMap(DEFAULT_STATUS_LABEL_MAP, 'status:', statusPrefix);

  const canWrite = syncDirection !== 'pull_only';
  const canRead = syncDirection !== 'push_only';

  async function ghFetch(path: string, options: RequestInit = {}): Promise<Response> {
    const url = path.startsWith('http') ? path : `${API_BASE}${path}`;
    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json',
      'User-Agent': 'HotSheet-GitHub-Plugin/0.1',
      ...(options.headers as Record<string, string> ?? {}),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(url, { ...options, headers });

    const remaining = parseInt(res.headers.get('x-ratelimit-remaining') || '999', 10);
    if (remaining < 10) {
      const resetTime = parseInt(res.headers.get('x-ratelimit-reset') || '0', 10) * 1000;
      const waitMs = Math.max(0, resetTime - Date.now()) + 1000;
      context.log('warn', `Rate limit low (${remaining} remaining), waiting ${Math.round(waitMs / 1000)}s`);
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }

    if (res.status === 403 && res.headers.get('x-ratelimit-remaining') === '0') {
      throw new Error('GitHub API rate limit exceeded');
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`GitHub API error ${res.status}: ${body.slice(0, 200)}`);
    }
    return res;
  }

  function issueToFields(issue: GitHubIssue): RemoteTicketFields {
    const labels = (issue.labels || []).map(l => typeof l === 'string' ? l : l.name);

    let category = 'issue';
    for (const label of labels) {
      if (categoryMap.toLocal[label]) { category = categoryMap.toLocal[label]; break; }
    }

    let priority = 'default';
    for (const label of labels) {
      if (priorityMap.toLocal[label]) { priority = priorityMap.toLocal[label]; break; }
    }

    // Status: read from label first (lossless), fall back to open/closed state
    let status = 'not_started';
    let statusFromLabel = false;
    for (const label of labels) {
      if (statusLabelMap.toLocal[label]) { status = statusLabelMap.toLocal[label]; statusFromLabel = true; break; }
    }
    if (!statusFromLabel) {
      // Legacy fallback: use open/closed state + in-progress label
      const isClosed = issue.state === 'closed';
      const isStarted = labels.includes('in-progress') || labels.includes('started');
      status = isClosed ? 'completed' : isStarted ? 'started' : 'not_started';
    }
    const upNext = labels.includes(upNextLabel);

    const knownLabels = new Set([
      ...Object.values(categoryMap.toRemote),
      ...Object.values(priorityMap.toRemote),
      ...Object.values(statusLabelMap.toRemote),
      upNextLabel, 'in-progress', 'started',
    ]);
    const tags = labels.filter(l => !knownLabels.has(l));

    // Milestone → tag
    if (issue.milestone) {
      tags.push(`${milestonePrefix}${issue.milestone.title}`);
    }

    return { title: issue.title, details: issue.body || '', category, priority, status, up_next: upNext, tags };
  }

  function ticketToLabels(ticket: Ticket): string[] {
    const labels: string[] = [];
    const catLabel = categoryMap.toRemote[ticket.category];
    if (catLabel) labels.push(catLabel);
    if (ticket.priority !== 'default') {
      const priLabel = priorityMap.toRemote[ticket.priority];
      if (priLabel) labels.push(priLabel);
    }
    // Status label (lossless mapping)
    const statusLabel = statusLabelMap.toRemote[ticket.status];
    if (statusLabel) labels.push(statusLabel);
    if (ticket.up_next) labels.push(upNextLabel);
    const tags: string[] = typeof ticket.tags === 'string' ? JSON.parse(ticket.tags || '[]') : (ticket.tags || []);
    for (const tag of tags) {
      // Skip milestone tags (handled separately)
      if (!tag.startsWith(milestonePrefix)) labels.push(tag);
    }
    return labels;
  }

  /** Extract milestone name from ticket tags, if present. */
  function getMilestoneFromTags(ticket: Ticket): string | null {
    const tags: string[] = typeof ticket.tags === 'string' ? JSON.parse(ticket.tags || '[]') : (ticket.tags || []);
    for (const tag of tags) {
      if (tag.startsWith(milestonePrefix)) return tag.slice(milestonePrefix.length);
    }
    return null;
  }

  /** Cache of milestone name → number for the repo. */
  let milestoneCache: Map<string, number> | null = null;

  async function getMilestoneNumber(name: string): Promise<number | null> {
    if (!milestoneCache) {
      milestoneCache = new Map();
      try {
        const res = await ghFetch(`/repos/${owner}/${repo}/milestones?state=all&per_page=100`);
        const milestones = await res.json() as GitHubMilestone[];
        for (const m of milestones) milestoneCache.set(m.title, m.number);
      } catch { /* ignore */ }
    }
    return milestoneCache.get(name) ?? null;
  }

  const backend: TicketingBackend = {
    id: 'github-issues',
    name: 'GitHub Issues',
    capabilities: {
      create: canWrite, update: canWrite, delete: canWrite,
      incrementalPull: canRead,
      syncableFields: ['title', 'details', 'category', 'priority', 'status', 'tags', 'up_next'],
      comments: true,
    },
    fieldMappings: {
      category: categoryMap as FieldMap,
      priority: priorityMap as FieldMap,
      status: statusLabelMap as FieldMap,
    },

    async checkConnection() {
      if (!token || !owner || !repo) {
        return { connected: false, error: 'Missing required configuration (token, owner, repo)' };
      }
      try {
        await ghFetch(`/repos/${owner}/${repo}`);
        return { connected: true };
      } catch (e) {
        return { connected: false, error: (e as Error).message };
      }
    },

    async createRemote(ticket) {
      if (!canWrite) throw new Error('Push disabled for this plugin');
      const labels = ticketToLabels(ticket);
      const issueBody: Record<string, unknown> = { title: ticket.title, body: ticket.details || undefined, labels };
      // Set milestone if present in tags
      const milestoneName = getMilestoneFromTags(ticket);
      if (milestoneName) {
        const milestoneNum = await getMilestoneNumber(milestoneName);
        if (milestoneNum) issueBody.milestone = milestoneNum;
      }
      const res = await ghFetch(`/repos/${owner}/${repo}/issues`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(issueBody),
      });
      const issue = await res.json() as GitHubIssue;
      context.log('info', `Created issue #${issue.number}`);
      return String(issue.number);
    },

    async updateRemote(remoteId, changes) {
      if (!canWrite) throw new Error('Push disabled for this plugin');
      const update: Record<string, unknown> = {};
      if (changes.title !== undefined) update.title = changes.title;
      if (changes.details !== undefined) update.body = changes.details;
      if (changes.status !== undefined) {
        // Set open/closed state based on status
        const ghState = GITHUB_STATE_FOR_STATUS[changes.status];
        if (ghState) update.state = ghState;
      }

      // Labels need updating for category, priority, status, up_next, or tags changes.
      // We must rebuild the full label set (not just changed fields) to avoid dropping existing labels.
      if (changes.category !== undefined || changes.priority !== undefined ||
          changes.status !== undefined || changes.up_next !== undefined || changes.tags !== undefined) {
        const issueRes = await ghFetch(`/repos/${owner}/${repo}/issues/${remoteId}`);
        const issue = await issueRes.json() as GitHubIssue;
        const currentLabels = (issue.labels || []).map(l => typeof l === 'string' ? l : l.name);
        const knownLabels = new Set([
          ...Object.values(categoryMap.toRemote), ...Object.values(priorityMap.toRemote),
          ...Object.values(statusLabelMap.toRemote),
          upNextLabel, 'in-progress', 'started',
        ]);
        const userLabels = currentLabels.filter(l => !knownLabels.has(l));

        // Read current values from the remote issue for fields NOT in changes
        const currentFields = issueToFields(issue);
        const effectiveCategory = changes.category ?? currentFields.category;
        const effectivePriority = changes.priority ?? currentFields.priority;
        const effectiveStatus = changes.status ?? currentFields.status;
        const effectiveUpNext = changes.up_next ?? currentFields.up_next;

        const newLabels: string[] = [];
        if (effectiveCategory && categoryMap.toRemote[effectiveCategory]) newLabels.push(categoryMap.toRemote[effectiveCategory]);
        if (effectivePriority && effectivePriority !== 'default' && priorityMap.toRemote[effectivePriority]) {
          newLabels.push(priorityMap.toRemote[effectivePriority]);
        }
        if (effectiveStatus && statusLabelMap.toRemote[effectiveStatus]) {
          newLabels.push(statusLabelMap.toRemote[effectiveStatus]);
        }
        if (effectiveUpNext) newLabels.push(upNextLabel);
        if (changes.tags) {
          // Filter out milestone tags — they're not GitHub labels
          for (const tag of changes.tags) {
            if (!tag.startsWith(milestonePrefix)) newLabels.push(tag);
          }
        } else {
          for (const l of userLabels) newLabels.push(l);
        }
        update.labels = newLabels;
      }

      if (Object.keys(update).length > 0) {
        await ghFetch(`/repos/${owner}/${repo}/issues/${remoteId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(update),
        });
        context.log('info', `Updated issue #${remoteId}`);
      }
    },

    async deleteRemote(remoteId) {
      if (!canWrite) throw new Error('Push disabled for this plugin');
      await ghFetch(`/repos/${owner}/${repo}/issues/${remoteId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      });
      context.log('info', `Closed issue #${remoteId}`);
    },

    async pullChanges(since): Promise<RemoteChange[]> {
      if (!canRead) return [];
      let page = 1;
      const allChanges: RemoteChange[] = [];
      const params = new URLSearchParams({ state: 'all', sort: 'updated', direction: 'desc', per_page: '100' });
      if (since) params.set('since', since.toISOString());
      if (filterLabels.length > 0) params.set('labels', filterLabels.join(','));

      while (true) {
        params.set('page', String(page));
        const res = await ghFetch(`/repos/${owner}/${repo}/issues?${params}`);
        const issues = await res.json() as GitHubIssue[];
        if (!Array.isArray(issues) || issues.length === 0) break;
        for (const issue of issues) {
          if (issue.pull_request) continue;
          allChanges.push({
            remoteId: String(issue.number),
            fields: issueToFields(issue),
            remoteUpdatedAt: new Date(issue.updated_at),
          });
        }
        const linkHeader = res.headers.get('link');
        if (!linkHeader || !linkHeader.includes('rel="next"')) break;
        page++;
      }

      context.log('info', `Pulled ${allChanges.length} issue(s)${since ? ` since ${since.toISOString()}` : ''}`);
      return allChanges;
    },

    shouldAutoSync(_ticket) {
      return autoSyncNew;
    },

    getRemoteUrl(remoteId) {
      if (!owner || !repo) return null;
      return `https://github.com/${owner}/${repo}/issues/${remoteId}`;
    },

    async getRemoteTicket(remoteId) {
      try {
        const res = await ghFetch(`/repos/${owner}/${repo}/issues/${remoteId}`);
        const issue = await res.json() as GitHubIssue;
        if (issue.pull_request) return null;
        return issueToFields(issue);
      } catch {
        return null;
      }
    },

    // --- Comments ---

    async getComments(remoteId): Promise<RemoteComment[]> {
      const res = await ghFetch(`/repos/${owner}/${repo}/issues/${remoteId}/comments?per_page=100`);
      const comments = await res.json() as { id: number; body: string; created_at: string; updated_at: string }[];
      return comments.map(c => ({
        id: String(c.id),
        text: c.body ?? '',
        createdAt: new Date(c.created_at),
        updatedAt: new Date(c.updated_at),
      }));
    },

    async createComment(remoteId, text) {
      const res = await ghFetch(`/repos/${owner}/${repo}/issues/${remoteId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
      const comment = await res.json() as { id: number };
      return String(comment.id);
    },

    async updateComment(_remoteId, commentId, text) {
      await ghFetch(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: text }),
      });
    },

    async deleteComment(_remoteId, commentId) {
      await ghFetch(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
        method: 'DELETE',
      });
    },

    // --- Attachments ---

    async uploadAttachment(filename, content, _mimeType) {
      if (!canUploadAttachments) {
        context.log('warn', `Attachment upload skipped: attachment_repo not configured (value: "${attachmentRepo ?? ''}")`);
        return null;
      }

      // Generate a unique path to avoid collisions
      const timestamp = Date.now().toString(36);
      const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
      const path = `${attachmentFolder}/${timestamp}-${safeName}`;
      const base64Content = content.toString('base64');

      try {
        const res = await ghFetch(`/repos/${attOwner}/${attRepo}/contents/${path}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Upload attachment: ${filename}`,
            content: base64Content,
            branch: attachmentBranch,
          }),
        });
        const data = await res.json() as { content?: { download_url?: string; html_url?: string } };
        const url = data.content?.download_url ?? data.content?.html_url;
        if (url) {
          context.log('info', `Uploaded attachment: ${filename} → ${url}`);
          return url;
        }
        return null;
      } catch (e) {
        context.log('error', `Failed to upload attachment ${filename}: ${(e as Error).message}`);
        return null;
      }
    },
  };

  _backend = backend;
  return backend;
}

function buildPrefixMap(defaultMap: FieldMapPair, defaultPrefix: string, newPrefix: string): FieldMapPair {
  if (newPrefix === defaultPrefix) return defaultMap;
  const toRemote: Record<string, string> = {};
  const toLocal: Record<string, string> = {};
  for (const [local, remote] of Object.entries(defaultMap.toRemote)) {
    const newRemote = remote.replace(defaultPrefix, newPrefix);
    toRemote[local] = newRemote;
    toLocal[newRemote] = local;
  }
  return { toRemote, toLocal };
}

/** Validate config field values. */
export async function validateField(key: string, value: string): Promise<{ status: string; message: string } | null> {
  if (key === 'token') {
    if (!value) return { status: 'error', message: 'Required' };
    if (!value.startsWith('ghp_') && !value.startsWith('github_pat_')) {
      return { status: 'warning', message: 'Token should start with ghp_ (classic) or github_pat_ (fine-grained)' };
    }
    if (value.startsWith('github_pat_')) {
      return { status: 'success', message: 'Fine-grained token — needs Issues + Contents (read/write) permissions' };
    }
    return { status: 'success', message: 'Classic token — needs repo scope' };
  }
  if (key === 'owner') {
    if (!value) return { status: 'error', message: 'Required' };
    if (/\s/.test(value)) return { status: 'error', message: 'Cannot contain spaces' };
    return null;
  }
  if (key === 'repo') {
    if (!value) return { status: 'error', message: 'Required' };
    if (/\s/.test(value)) return { status: 'error', message: 'Cannot contain spaces' };
    return null;
  }
  return null;
}

/** Handle UI action callbacks. */
export async function onAction(actionId: string, _actionContext: { ticketIds?: number[]; value?: unknown }): Promise<unknown> {
  if (actionId === 'sync') {
    return { redirect: 'sync' };
  }
  if (actionId === 'test_connection') {
    if (!_backend) {
      _context?.updateConfigLabel('connection-status', 'Not configured');
      return { connected: false, error: 'Plugin not activated' };
    }
    try {
      const result = await _backend.checkConnection();
      _context?.updateConfigLabel('connection-status', result.connected ? 'Connected' : `Disconnected: ${result.error ?? 'Unknown'}`);
      return result;
    } catch (e) {
      const msg = `Error: ${e instanceof Error ? e.message : String(e)}`;
      _context?.updateConfigLabel('connection-status', msg);
      return { connected: false, error: msg };
    }
  }
  return null;
}
