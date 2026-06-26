/**
 * HS-8634 — projects typed-API module. Verifies the callers hit the right
 * path + method (and forward the cross-project `secret` to `apiCall`'s
 * `opts.secret`, which the transport routes to `apiWithSecret`), the
 * long-poll callers build the `?v=` cursor, and the response schemas accept
 * a real payload / reject a malformed one. Also pins the `PermissionData`
 * reconciliation: a partial permission entry validates with '' defaults
 * rather than failing, so a real pending request is never dropped on the
 * long-poll.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  deleteProject, getProjectsChannelStatus, getProjectsFeedbackState, getQuitSummary,
  listProjects, pollBellState, pollProjectPermissions, ProjectListItemSchema,
  ProjectsBellStateSchema, ProjectsPermissionsSchema, QuitSummarySchema, RegisteredProjectSchema,
  registerProject, reorderProjects, revealProject,
} from './projects.js';

// HS-9056 — a real `GET /projects` row carries openCount/upNextCount; keep the
// fixture in lockstep with ProjectListItemSchema so listProjects() round-trips it.
const projectRow = { name: 'hotsheet', dataDir: '/Users/x/hotsheet', secret: 'sek', ticketCount: 7, openCount: 3, upNextCount: 2 };
const permissions = {
  permissions: { sek: { request_id: 'r1', tool_name: 'Bash', description: 'ls', input_preview: 'ls -la' }, other: null },
  v: 3,
};
const bellState = {
  bells: { sek: { anyTerminalPending: true, terminalIds: ['default'], notifications: { default: 'Build done' } } },
  v: 5,
};
const quitSummary = {
  projects: [{
    secret: 'sek', name: 'hotsheet', confirmMode: 'with-non-exempt-processes',
    entries: [{ terminalId: 'default', label: 'Shell', foregroundCommand: 'claude', isShell: false, isExempt: false }],
  }],
};

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}

afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('projects schemas (HS-8634)', () => {
  it('accepts valid payloads and rejects malformed ones', () => {
    expect(ProjectListItemSchema.safeParse(projectRow).success).toBe(true);
    expect(RegisteredProjectSchema.safeParse({ name: 'p', dataDir: '/d', secret: 's' }).success).toBe(true);
    expect(ProjectsPermissionsSchema.safeParse(permissions).success).toBe(true);
    expect(ProjectsBellStateSchema.safeParse(bellState).success).toBe(true);
    expect(QuitSummarySchema.safeParse(quitSummary).success).toBe(true);

    // ticketCount must be a number.
    expect(ProjectListItemSchema.safeParse({ ...projectRow, ticketCount: '7' }).success).toBe(false);
    // bell-state version must be present.
    expect(ProjectsBellStateSchema.safeParse({ bells: {} }).success).toBe(false);
    // quit-summary confirmMode is a closed enum.
    expect(QuitSummarySchema.safeParse({
      projects: [{ ...quitSummary.projects[0], confirmMode: 'sometimes' }],
    }).success).toBe(false);
  });

  it('PermissionData reconciliation: a partial entry validates with "" defaults, never dropped', () => {
    // The server schema is all-optional + .loose() (carries an extra
    // tool_input); the client requires request_id / tool_name / description.
    // `.catch('')` keeps the entry rather than failing the whole long-poll.
    const parsed = ProjectsPermissionsSchema.safeParse({
      permissions: { sek: { tool_input: { cmd: 'x' } } },
      v: 1,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.data?.permissions.sek).toEqual({ request_id: '', tool_name: '', description: '' });
  });
});

describe('projects callers route to the right endpoint (HS-8634)', () => {
  it('listProjects → GET /projects, forwarding secret', async () => {
    stub([projectRow]);
    expect(await listProjects()).toEqual([projectRow]);
    expect(lastCall).toEqual({ path: '/projects', opts: { secret: undefined } });
    await listProjects('sek');
    expect(lastCall).toEqual({ path: '/projects', opts: { secret: 'sek' } });
  });

  it('registerProject → POST /projects/register with { dataDir }', async () => {
    stub({ name: 'p', dataDir: '/d', secret: 's' });
    await registerProject('/d');
    expect(lastCall).toEqual({ path: '/projects/register', opts: { method: 'POST', body: { dataDir: '/d' } } });
  });

  it('deleteProject → DELETE /projects/:secret (encoded)', async () => {
    stub({ ok: true });
    await deleteProject('a/b sek');
    expect(lastCall).toEqual({ path: '/projects/a%2Fb%20sek', opts: { method: 'DELETE' } });
  });

  it('getProjectsChannelStatus → GET /projects/channel-status', async () => {
    stub({ enabled: true, projects: { sek: true } });
    expect(await getProjectsChannelStatus()).toEqual({ enabled: true, projects: { sek: true } });
    expect(lastCall?.path).toBe('/projects/channel-status');
  });

  it('getProjectsFeedbackState → GET /projects/feedback-state, unwrapped to the map', async () => {
    stub({ projects: { sek: true, other: false } });
    expect(await getProjectsFeedbackState()).toEqual({ sek: true, other: false });
    expect(lastCall?.path).toBe('/projects/feedback-state');
  });

  it('pollProjectPermissions → GET /projects/permissions?v=, forwarding secret', async () => {
    stub(permissions);
    await pollProjectPermissions(3);
    expect(lastCall).toEqual({ path: '/projects/permissions?v=3', opts: { secret: undefined } });
    await pollProjectPermissions(0, 'sek');
    expect(lastCall).toEqual({ path: '/projects/permissions?v=0', opts: { secret: 'sek' } });
  });

  it('pollBellState → GET /projects/bell-state?v=', async () => {
    stub(bellState);
    expect(await pollBellState(5)).toEqual(bellState);
    expect(lastCall?.path).toBe('/projects/bell-state?v=5');
  });

  it('revealProject → POST /projects/:secret/reveal', async () => {
    stub({ ok: true });
    await revealProject('sek');
    expect(lastCall).toEqual({ path: '/projects/sek/reveal', opts: { method: 'POST' } });
  });

  it('reorderProjects → POST /projects/reorder with { secrets }', async () => {
    stub({ ok: true });
    await reorderProjects(['a', 'b']);
    expect(lastCall).toEqual({ path: '/projects/reorder', opts: { method: 'POST', body: { secrets: ['a', 'b'] } } });
  });

  it('getQuitSummary → GET /projects/quit-summary', async () => {
    stub(quitSummary);
    expect(await getQuitSummary()).toEqual(quitSummary);
    expect(lastCall?.path).toBe('/projects/quit-summary');
  });

  it('rejects a list response that fails schema validation', async () => {
    stub([{ ...projectRow, ticketCount: 'lots' }]);
    await expect(listProjects()).rejects.toThrow(/response shape mismatch/);
  });
});
