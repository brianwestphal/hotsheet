import { execFileSync } from 'child_process';
import { Hono } from 'hono';

import { checkChannelVersion, getChannelPort, isChannelAlive, registerChannel, registerChannelForAll, shutdownChannel, slugifyDataDir, triggerChannel, unregisterChannel, unregisterChannelForAll } from '../channel-config.js';
import { appendMainServerEvent } from '../channelLog.js';
import { disconnectMainConnections, listAliveEntries } from '../channelRegistry.js';
import { installHeartbeatHook, removeHeartbeatHook } from '../claude-hooks.js';
import { addLogEntry, updateLogEntry } from '../db/commandLog.js';
import { getSettings } from '../db/settings.js';
import { closeOpenTicketIntervalsForProject } from '../db/ticketWorkIntervals.js';
import { instrumentAsync } from '../diagnostics/freezeLogger.js';
import { readFileSettings } from '../file-settings.js';
import { readGlobalConfig, writeGlobalConfig } from '../global-config.js';
import { extractPrimaryValue, findMatchingAllowRule, parseAllowRules } from '../permissionAllowRules.js';
import { ensureSkillsForAllProjects, getAllProjects } from '../projects.js';
import { PendingPermissionSchema } from '../schemas.js';
import { flushPendingSyncs } from '../sync/markdown.js';
import type { AppEnv } from '../types.js';
import { addPermissionWaiter, notifyChange, notifyPermission } from './notify.js';
import { ChannelHeartbeatSchema, ChannelTriggerSchema, parseBody, PermissionRespondSchema } from './validation.js';

export const channelRoutes = new Hono<AppEnv>();

// HS-8456 — track the last-known channel-alive state per dataDir so the
// `/channel/status` handler can write a single line to `<dataDir>/mcp.log`
// on every false→true / true→false flip without flooding the log on
// every poll. `null` = no probe has run yet. Module-private because
// only the status handler reads / writes.
const lastAliveByDataDir = new Map<string, boolean>();

/** HS-8456 — record an alive/dead transition. Returns the prior value
 *  (or `null` if this is the first probe for `dataDir`). Exported for
 *  test reset; production callers go through `noteChannelAliveProbe`. */
export function _resetChannelAliveTrackerForTesting(): void {
  lastAliveByDataDir.clear();
}

/** HS-8456 — call after every `isChannelAlive(dataDir)` probe. Writes a
 *  single `channel-alive-transition` line to `<dataDir>/mcp.log` if the
 *  observed value differs from the last one we saw. No-op on the first
 *  probe of a fresh process (no prior value → no transition to record),
 *  which keeps the first dashboard load from spamming the log with the
 *  baseline state. Failure-open via the underlying `appendMainServerEvent`.
 *  Exported so the unit test in `channelAliveTracker.test.ts` can call it
 *  directly without standing up a full Hono request flow. */
export function noteChannelAliveProbe(dataDir: string, alive: boolean): void {
  const prior = lastAliveByDataDir.get(dataDir);
  lastAliveByDataDir.set(dataDir, alive);
  if (prior === undefined || prior === alive) return;
  appendMainServerEvent(dataDir, 'channel-alive-transition', `${String(prior)} → ${String(alive)}`);
}

// Per-project done flags, keyed by project secret
const channelDoneFlags = new Map<string, boolean>();

// Track which permission request_ids we've already logged to avoid duplicates
const loggedPermissionRequests = new Map<string, number>(); // request_id -> log entry id

channelRoutes.get('/channel/claude-check', (c) => {
  try {
    const version = execFileSync('claude', ['--version'], { timeout: 5000, encoding: 'utf-8' }).trim();
    // Version string like "Claude Code v2.1.85" or just "2.1.85"
    const match = version.match(/(\d+\.\d+\.\d+)/);
    const versionNum = match !== null ? match[1] : null;
    const parts = versionNum !== null ? versionNum.split('.').map(Number) : [];
    // Requires v2.1.80+
    const meetsMinimum = parts.length === 3 && (
      parts[0] > 2 || (parts[0] === 2 && parts[1] > 1) || (parts[0] === 2 && parts[1] === 1 && parts[2] >= 80)
    );
    return c.json({ installed: true, version: versionNum, meetsMinimum });
  } catch {
    return c.json({ installed: false, version: null, meetsMinimum: false });
  }
});

channelRoutes.get('/channel/status', async (c) => {
  const dataDir = c.get('dataDir');
  // Channel enabled is a global setting; fall back to legacy per-project DB (read-only)
  const globalConfig = readGlobalConfig();
  let enabled: boolean;
  if (globalConfig.channelEnabled !== undefined) {
    enabled = globalConfig.channelEnabled;
  } else {
    const settings = await getSettings();
    enabled = settings.channel_enabled === 'true';
  }
  const port = getChannelPort(dataDir);
  const alive = enabled ? await isChannelAlive(dataDir) : false;
  // HS-8456 — record alive transitions in `<dataDir>/mcp.log` so a
  // disconnect post-mortem has the main server's half of the timeline
  // alongside the channel server's `process-start` / `disconnect` /
  // `cleanup-end` entries. No-op on the steady state to avoid flooding.
  noteChannelAliveProbe(dataDir, alive);
  // Consume the done flag for this project (read once, then clear)
  const projectSecret = c.get('projectSecret');
  const done = channelDoneFlags.get(projectSecret) === true;
  if (done) channelDoneFlags.delete(projectSecret);
  // Check if the running channel server version matches the expected version
  let versionMismatch = false;
  if (alive) {
    const vCheck = await checkChannelVersion(dataDir);
    if (vCheck !== null && !vCheck.match) {
      versionMismatch = true;
      // HS-8456 — surface the actual version pair so an upgrade /
      // rollback boundary is obvious in `mcp.log` without grepping the
      // codebase for the current expected value.
      appendMainServerEvent(dataDir, 'channel-version-mismatch', `running=${String(vCheck.running)} expected=${String(vCheck.expected)}`);
    }
  }
  // HS-8349 — the per-project MCP server name. The client uses this to
  // render the per-project `claude --dangerously-load-development-channels
  // server:hotsheet-channel-<slug>` command in Settings → Experimental.
  const serverName = `hotsheet-channel-${slugifyDataDir(dataDir)}`;
  // HS-8460 — count alive channel-servers for the multi-connection
  // warning indicator. When > 1, the client surfaces "N Claude
  // connections active — triggers route to the oldest one." Lazy
  // import to keep this route's cold-path cost zero when the channel
  // is disabled.
  let aliveCount = 0;
  if (alive) {
    const entries = listAliveEntries(dataDir);
    // HS-9038 — count only MAIN (non-worktree) connections. A distributed worker
    // spawns its own channel server (registered under the owner data dir), so with
    // workers running there are legitimately many alive servers — that's expected,
    // not a duplicate-connection problem. The warning should fire only on multiple
    // MAIN agents (the actual orphan/duplicate case it was built for).
    const mains = entries.filter(e => e.worktree == null);
    aliveCount = mains.length;
    // HS-8948 — when >1 MAIN channel-server is alive, log the roster so a recurring
    // "N connections" can be diagnosed from mcp.log. Deduped per (dataDir →
    // signature) so the frequently-polled status route logs only on a real change.
    if (aliveCount > 1) {
      const signature = mains.map(e => `${String(e.pid)}@${e.startedAt ?? '?'}`).join(',');
      if (lastMultiConnSignature.get(dataDir) !== signature) {
        lastMultiConnSignature.set(dataDir, signature);
        appendMainServerEvent(dataDir, 'multi-connection', `${String(aliveCount)} main channel servers (${String(entries.length - aliveCount)} worker) — leader pid=${String(mains[0].pid)}; mains=[${signature}]`);
      }
    } else {
      lastMultiConnSignature.delete(dataDir);
    }
  }
  return c.json({ enabled, alive, port, done, versionMismatch, serverName, aliveCount });
});

/** HS-8948 — per-dataDir dedup of the multi-connection diagnostic log so the
 *  polled status route only records a roster change, not every tick. */
const lastMultiConnSignature = new Map<string, string>();

/**
 * HS-8948 / HS-9225 — disconnect Claude channel connections for the active
 * project. Terminates every alive MAIN channel-server (including the leader) —
 * clearing the ambiguous "which one is the right one" state. The client then
 * tells the user to run `/mcp` in the Claude instance they want, which
 * reconnects a fresh server as the sole connection. Distributed-worker
 * connections are spared. Returns the count disconnected.
 */
channelRoutes.post('/channel/cleanup-connections', (c) => {
  const dataDir = c.get('dataDir');
  const killed = disconnectMainConnections(dataDir);
  if (killed.length > 0) {
    appendMainServerEvent(dataDir, 'multi-connection-cleanup', `disconnected ${String(killed.length)} main channel server(s): [${killed.join(',')}]`);
    lastMultiConnSignature.delete(dataDir); // force a fresh roster log next status poll
  }
  return c.json({ ok: true, killed: killed.length });
});

channelRoutes.post('/channel/trigger', async (c) => {
  const dataDir = c.get('dataDir');
  const serverPort = parseInt(new URL(c.req.url).port || '4174', 10);
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ChannelTriggerSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  channelDoneFlags.delete(c.get('projectSecret')); // Reset done flag on new trigger
  loggedPermissionRequests.clear(); // Reset dedup set for new session
  // HS-8362 — instrument the heaviest channel route. `triggerChannel` shells
  // out to spawn the channel server subprocess (or wakes the existing one
  // over its localhost HTTP port); `flushPendingSyncs` is already covered
  // by the HS-8360 phase 1 wraps but the outer trigger pass includes the
  // serial waterfall (sync flush → spawn → log entry) so the route-level
  // wrap captures the cumulative wall-clock if any of the inner phases
  // stalls in a way the per-phase instrumentation didn't expect.
  const ok = await instrumentAsync(dataDir, 'channel.trigger', async () => {
    // Flush pending markdown syncs so worklist/open-tickets are up to date before Claude reads them
    await flushPendingSyncs(dataDir);
    // HS-9084 — optional `target` routes to a specific worker / all workers;
    // omitted ⇒ the FIFO leader (the play-button / worklist default).
    return triggerChannel(dataDir, serverPort, parsed.data.message, parsed.data.target);
  });
  const summary = parsed.data.message !== undefined && parsed.data.message !== '' ? parsed.data.message.slice(0, 200) : 'Worklist trigger';
  addLogEntry('trigger', 'outgoing', summary, parsed.data.message ?? '').catch(() => {});
  return c.json({ ok });
});

type PermissionResult = { pending: { request_id?: string; tool_name?: string; description?: string; input_preview?: string; tool_input?: unknown } | null };

/** HS-9036 — request_id → the channel-server port it came from, so respond /
 *  dismiss route back to the SAME server. Every Claude instance (the main agent
 *  AND each worktree worker) spawns its own channel server, so a permission can
 *  originate from any of them, not just the leader. */
const requestSourcePort = new Map<string, number>();

/** All alive channel-server ports for this project — the main agent's AND each
 *  worktree worker's (they register under the owner's data dir via the owner-
 *  direct `.mcp.json`, HS-8936). Falls back to the single leader port for a
 *  legacy/registry-less setup. */
function alivePorts(dataDir: string): number[] {
  const ports = listAliveEntries(dataDir)
    .map(e => e.port)
    .filter((p): p is number => typeof p === 'number');
  if (ports.length > 0) return [...new Set(ports)];
  const leader = getChannelPort(dataDir);
  return leader === null ? [] : [leader];
}

/** HS-9036 — fetch the first pending permission across ALL alive channel servers
 *  for the project, so a permission raised inside a worktree worker (its own
 *  channel server, not the leader) surfaces in Hot Sheet too. Records the source
 *  port so respond/dismiss reach the right server. */
async function fetchPermission(dataDir: string): Promise<PermissionResult> {
  const ports = alivePorts(dataDir);
  const results = await Promise.all(
    ports.map(async (port) => ({ port, result: await fetchPermissionFromPort(dataDir, port) })),
  );
  for (const { port, result } of results) {
    if (result.pending !== null) {
      const reqId = result.pending.request_id ?? '';
      if (reqId !== '') requestSourcePort.set(reqId, port);
      return result;
    }
  }
  return { pending: null };
}

/** Fetch + process the pending permission from ONE channel server (the auto-allow
 *  gate + new-request logging). */
async function fetchPermissionFromPort(dataDir: string, port: number): Promise<PermissionResult> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/permission`);
    // HS-8567 — validate at the wire boundary.
    const rawJson: unknown = await res.json();
    const parsed = PendingPermissionSchema.safeParse(rawJson);
    if (!parsed.success) return { pending: null };
    const data: PermissionResult = { pending: parsed.data.pending };
    if (data.pending !== null) {
      const reqId = data.pending.request_id ?? '';
      const toolName = data.pending.tool_name ?? 'unknown tool';
      const description = data.pending.description ?? '';
      const inputPreview = data.pending.input_preview ?? (
        data.pending.tool_input !== undefined ? JSON.stringify(data.pending.tool_input, null, 2).slice(0, 2000) : ''
      );

      // HS-7952 — auto-allow gate. If a configured rule matches the
      // (tool, primary-field-value) pair, immediately POST `/permission/respond`
      // with `behavior: 'allow'` to the channel server. Bypasses the
      // long-poll wake entirely so no popup ever renders for this
      // request. Logged to `command_log` as
      // `Permission: <tool> — Auto-allowed (rule <id>)` for audit.
      if (reqId !== '' && !autoAllowedRequests.has(reqId)) {
        const settings = readFileSettings(dataDir);
        const rules = parseAllowRules(settings.permission_allow_rules);
        if (rules.length > 0) {
          const primary = extractPrimaryValue(toolName, inputPreview);
          if (primary !== null) {
            const match = findMatchingAllowRule(toolName, primary, rules);
            if (match !== null) {
              autoAllowedRequests.add(reqId);
              // Log the auto-allow (audit trail).
              addLogEntry(
                'permission_request',
                'incoming',
                `Permission: ${toolName} — Auto-allowed (rule ${match.id})`,
                (description !== '' ? description + '\n\n' : '') + inputPreview,
              ).catch(() => {});
              // Forward the allow to the channel server. Fire-and-forget;
              // any error is logged + the user will see the popup on the
              // next long-poll cycle (graceful degradation).
              fetch(`http://127.0.0.1:${port}/permission/respond`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ request_id: reqId, behavior: 'allow' }),
              }).catch(() => { /* swallow */ });
              // Hide the pending state from the long-poll caller — the
              // popup never renders for this request.
              return { pending: null };
            }
          }
        }
      }

      if (reqId !== '' && !loggedPermissionRequests.has(reqId)) {
        const detail = (description !== '' ? description + '\n\n' : '') + inputPreview;
        addLogEntry('permission_request', 'incoming', `Permission: ${toolName}`, detail)
          .then(entry => { loggedPermissionRequests.set(reqId, entry.id); })
          .catch(() => { loggedPermissionRequests.set(reqId, 0); });
      }
    }
    return data;
  } catch {
    return { pending: null };
  }
}

/** HS-7952 — request_ids we've already auto-allowed, so a long-poll race
 *  doesn't double-allow + double-log the same request. The set never gets
 *  GC'd within a process lifetime — request_ids are random per-Claude-call,
 *  not enumerated, so unbounded growth is bounded by Claude's usage. */
const autoAllowedRequests = new Set<string>();

/** Long-poll: returns immediately if a permission is pending, otherwise waits up to 3s. */
channelRoutes.get('/channel/permission', async (c) => {
  const dataDir = c.get('dataDir');
  const immediate = await fetchPermission(dataDir);
  if (immediate.pending !== null) return c.json(immediate);

  // Wait for a permission notification or 3s timeout
  await Promise.race([
    new Promise<void>((resolve) => { addPermissionWaiter(resolve); }),
    new Promise<void>((resolve) => { setTimeout(resolve, 3000); }),
  ]);

  return c.json(await fetchPermission(dataDir));
});

channelRoutes.post('/channel/permission/respond', async (c) => {
  const dataDir = c.get('dataDir');
  const raw: unknown = await c.req.json();
  const parsed = parseBody(PermissionRespondSchema, raw);
  if (!parsed.success) return c.json({ error: parsed.error }, 400);
  // HS-9036 — route the response to the SAME channel server that raised it (a
  // worktree worker's, not necessarily the leader); fall back to the leader.
  const port = requestSourcePort.get(parsed.data.request_id) ?? getChannelPort(dataDir);
  if (port === null) return c.json({ error: 'Channel not available' }, 503);
  const action = parsed.data.behavior === 'allow' ? 'Allowed' : 'Denied';
  const toolName = parsed.data.tool_name ?? 'tool';
  // Update the existing permission_request entry with the response instead of creating a new one
  const logId = loggedPermissionRequests.get(parsed.data.request_id);
  if (logId !== undefined && logId > 0) {
    updateLogEntry(logId, { summary: `Permission: ${toolName} — ${action}` }).catch(() => {});
  } else {
    // Race: the respond came in before fetchPermission logged the original
    // request (or the channel cleared it after the user answered in the
    // terminal first). Build the detail body from whatever context the
    // client provided so the log entry is still useful (HS-6477) — falling
    // back to the raw body only if neither description nor input_preview
    // came through.
    const description = parsed.data.description ?? '';
    const inputPreview = parsed.data.input_preview ?? '';
    let detail: string;
    if (description !== '' || inputPreview !== '') {
      detail = (description !== '' ? description + '\n\n' : '') + inputPreview;
    } else {
      detail = JSON.stringify(parsed.data);
    }
    addLogEntry('permission_request', 'incoming', `Permission: ${toolName} — ${action}`, detail).catch(() => {});
  }
  try {
    const res = await fetch(`http://127.0.0.1:${port}/permission/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(parsed.data),
    });
    requestSourcePort.delete(parsed.data.request_id); // answered — drop the routing entry
    return c.json(await res.json());
  } catch {
    return c.json({ error: 'Failed to reach channel server' }, 503);
  }
});

channelRoutes.post('/channel/permission/dismiss', async (c) => {
  const dataDir = c.get('dataDir');
  // HS-9036 — the pending permission may live on any worker's channel server, and
  // dismiss carries no request_id, so clear it on every alive server (a no-op on
  // the ones with nothing pending).
  await Promise.all(
    alivePorts(dataDir).map((port) =>
      fetch(`http://127.0.0.1:${port}/permission/dismiss`, { method: 'POST' }).catch(() => { /* ignore */ })),
  );
  return c.json({ ok: true });
});

channelRoutes.post('/channel/done', (_c) => {
  const secret = _c.get('projectSecret');
  if (secret) {
    channelDoneFlags.set(secret, true);
    // HS-8730 — the work session ended; close any ticket work interval left
    // open (e.g. a FEEDBACK NEEDED hand-off that left a ticket `started`) so it
    // can't keep accruing unrelated future cost.
    void closeOpenTicketIntervalsForProject(secret);
  }
  addLogEntry('done', 'incoming', 'Claude finished', '').catch(() => {});
  notifyChange(); // Triggers long-poll so client picks up the done state
  return _c.json({ ok: true });
});

channelRoutes.post('/channel/enable', async (c) => {
  const dataDir = c.get('dataDir');
  writeGlobalConfig({ channelEnabled: true });
  // Register .mcp.json and ensure skills for ALL projects
  const serverPort = parseInt(new URL(c.req.url).port || '4174', 10);
  try {
    const projects = getAllProjects();
    registerChannelForAll(projects.map(p => p.dataDir));
    // HS-8910 — per-project categories (not the process-global) so one project's
    // custom category can't leak its `hs-*` skill into every other project.
    await ensureSkillsForAllProjects();
  } catch {
    registerChannel(dataDir);
  }
  // Install Claude Code hook for busy state detection
  installHeartbeatHook(serverPort);
  notifyChange();
  return c.json({ ok: true });
});

channelRoutes.post('/channel/disable', async (c) => {
  const dataDir = c.get('dataDir');
  writeGlobalConfig({ channelEnabled: false });
  try {
    const projects = getAllProjects();
    unregisterChannelForAll(projects.map(p => p.dataDir));
    for (const p of projects) {
      await shutdownChannel(p.dataDir);
    }
  } catch {
    unregisterChannel(dataDir);
    await shutdownChannel(dataDir);
  }
  // Remove Claude Code heartbeat hook
  removeHeartbeatHook();
  notifyChange();
  return c.json({ ok: true });
});

/** Heartbeat from Claude Code hooks — reports busy/idle/heartbeat state for a project.
 *  state: 'busy' (UserPromptSubmit), 'idle' (Stop), 'heartbeat' (PostToolUse) */
channelRoutes.post('/channel/heartbeat', async (c) => {
  const raw: unknown = await c.req.json().catch(() => ({}));
  const parsed = parseBody(ChannelHeartbeatSchema, raw);
  if (!parsed.success) return c.json({ ok: false });
  const projectDir = parsed.data.projectDir;
  const hookState = parsed.data.state ?? 'heartbeat';
  if (projectDir === undefined || projectDir === '') return c.json({ ok: false });

  // Match projectDir against registered projects (projectDir is the root, dataDir is root/.hotsheet)
  const projects = getAllProjects();
  const match = projects.find(p => {
    const rootDir = p.dataDir.replace(/\/.hotsheet\/?$/, '');
    return rootDir === projectDir || projectDir.startsWith(rootDir + '/');
  });
  if (!match) return c.json({ ok: false });

  // Store the state change for the client to consume
  heartbeatUpdates.push({ secret: match.secret, state: hookState });
  notifyChange();
  return c.json({ ok: true, project: match.name });
});

/** Per-project heartbeat updates. Consumed and cleared by the client via /channel/heartbeat-status. */
const heartbeatUpdates: { secret: string; state: string }[] = [];

channelRoutes.get('/channel/heartbeat-status', (c) => {
  const updates = [...heartbeatUpdates];
  heartbeatUpdates.length = 0;
  return c.json({ updates });
});

/** Called by the channel server process when it starts or stops, to wake the long-poll. */
channelRoutes.post('/channel/notify', (c) => {
  notifyChange();
  return c.json({ ok: true });
});

/** Called by the channel server when a permission request arrives, to wake the permission long-poll. */
channelRoutes.post('/channel/permission/notify', (c) => {
  notifyPermission();
  return c.json({ ok: true });
});

