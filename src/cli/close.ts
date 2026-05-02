/**
 * HS-8089 — CLI close / list / join flows extracted from `src/cli.ts`.
 *
 * `handleClose` (--close), `handleList` (--list), `joinRunningInstance`
 * (default behaviour when an instance is already running on this port),
 * and `shutdownRunningInstance` (--replace's wait-for-port-free helper)
 * all share the same pattern: read `~/.hotsheet/instance.json`, talk to
 * the running instance over HTTP, exit cleanly.
 */
import { execFile } from 'child_process';
import { resolve } from 'path';

import { isInstanceRunning, readInstanceFile } from '../instance.js';

/**
 * Shut down any running Hot Sheet instance and wait for its port to become
 * free. Used by --replace. No-op if no instance is running.
 */
export async function shutdownRunningInstance(instancePort: number): Promise<void> {
  try {
    // Origin header bypasses the secret-mutation guard (same-origin
    // localhost exemption).
    await fetch(`http://localhost:${instancePort}/api/shutdown`, {
      method: 'POST',
      headers: { 'Origin': `http://localhost:${instancePort}` },
    });
  } catch {
    // Connection error means the server is already gone — fine.
    return;
  }

  // Poll until the port stops responding (server has ~500 ms between
  // response and exit).
  const deadlineMs = Date.now() + 10_000;
  while (Date.now() < deadlineMs) {
    await new Promise(r => setTimeout(r, 200));
    if (!(await isInstanceRunning(instancePort))) return;
  }
  throw new Error(`Running Hot Sheet instance on port ${instancePort} did not exit within 10s`);
}

/**
 * Handle --close: unregister the current project from a running instance.
 *
 * HS-7596 / §37 — when this project has alive terminals running non-
 * exempt processes, prompt the user to confirm before destroying them.
 * Pass `--force` to skip the prompt for non-interactive use (CI /
 * scripts).
 */
export async function handleClose(dataDir: string, force: boolean): Promise<void> {
  const instance = readInstanceFile();
  if (instance === null) {
    console.error('No running Hot Sheet instance found.');
    process.exit(1);
  }

  const running = await isInstanceRunning(instance.port);
  if (!running) {
    console.error('Hot Sheet instance is not responding. It may have exited unexpectedly.');
    process.exit(1);
  }

  // Read the secret for this project's dataDir so we can unregister by secret.
  const { readFileSettings } = await import('../file-settings.js');
  const settings = readFileSettings(dataDir);
  if (settings.secret === undefined || settings.secret === '') {
    console.error(`No project secret found in ${dataDir}/settings.json. Is this a Hot Sheet project directory?`);
    process.exit(1);
  }

  // HS-7596 / §37 — prompt before destroying terminals running non-exempt
  // processes. Skipped on --force.
  if (!force) {
    const proceed = await confirmCloseAgainstQuitSummary(instance.port, settings.secret);
    if (!proceed) {
      console.log('  Cancelled.');
      process.exit(0);
    }
  }

  const res = await fetch(`http://localhost:${instance.port}/api/projects/${settings.secret}`, {
    method: 'DELETE',
  });

  if (res.ok) {
    console.log(`  Project unregistered from running instance.`);
  } else {
    const body = await res.json() as { error?: string };
    console.error(`  Failed to unregister: ${body.error ?? 'Unknown error'}`);
    process.exit(1);
  }
}

/**
 * HS-7596 / §37 — fetch /api/projects/quit-summary, filter to the project
 * being closed, apply the §37.5 logic, and prompt the user via stdin if
 * the prompt should fire. Returns true to proceed, false to abort.
 *
 * Errors fetching the summary fall through to "no prompt needed" — the
 * server may not yet have the route (older instance), and we don't want
 * --close to start failing for users on older servers.
 */
async function confirmCloseAgainstQuitSummary(port: number, secret: string): Promise<boolean> {
  let summary: { projects: Array<{
    secret: string; name: string;
    confirmMode: 'always' | 'never' | 'with-non-exempt-processes';
    entries: Array<{ terminalId: string; label: string; foregroundCommand: string; isShell: boolean; isExempt: boolean }>;
  }> };
  try {
    const res = await fetch(`http://localhost:${port}/api/projects/quit-summary`);
    if (!res.ok) return true;
    summary = await res.json() as typeof summary;
  } catch {
    return true;
  }
  const project = summary.projects.find(p => p.secret === secret);
  if (project === undefined) return true;

  if (project.confirmMode === 'never') return true;
  let entriesToShow: typeof project.entries;
  if (project.confirmMode === 'always') {
    entriesToShow = project.entries;
    if (entriesToShow.length === 0) {
      // 'always' fires unconditionally. Prompt with no list.
      return promptYesNo(`  Close project "${project.name}"? Quit-confirm is set to 'always'.`);
    }
  } else {
    // 'with-non-exempt-processes': only fire when at least one is non-exempt.
    entriesToShow = project.entries.filter(e => !e.isExempt);
    if (entriesToShow.length === 0) return true;
  }

  console.log(`  Project "${project.name}" has the following terminals running:`);
  for (const e of entriesToShow) {
    console.log(`    • ${e.label} (${e.foregroundCommand})`);
  }
  return promptYesNo('  Close anyway?');
}

/** Minimal y/n stdin prompt for the CLI. Defaults to 'no' on EOF / blank. */
function promptYesNo(message: string): Promise<boolean> {
  return new Promise<boolean>((resolveFn) => {
    process.stdout.write(`${message} [y/N] `);
    let buffered = '';
    const onData = (chunk: Buffer): void => {
      buffered += chunk.toString('utf8');
      const newlineIdx = buffered.indexOf('\n');
      if (newlineIdx === -1) return;
      process.stdin.removeListener('data', onData);
      process.stdin.pause();
      const line = buffered.slice(0, newlineIdx).trim().toLowerCase();
      resolveFn(line === 'y' || line === 'yes');
    };
    process.stdin.resume();
    process.stdin.on('data', onData);
  });
}

/** Handle --list: list all projects registered with the running instance. */
export async function handleList(port: number): Promise<void> {
  const res = await fetch(`http://localhost:${port}/api/projects`);
  if (!res.ok) {
    console.error('Failed to fetch project list from running instance.');
    process.exit(1);
  }

  const projects = await res.json() as Array<{ name: string; dataDir: string; ticketCount: number }>;
  if (projects.length === 0) {
    console.log('  No projects registered.');
    return;
  }

  console.log(`\n  Registered projects (${projects.length}):\n`);
  for (const p of projects) {
    console.log(`    ${p.name}`);
    console.log(`      ${p.dataDir}  (${p.ticketCount} tickets)`);
  }
  console.log('');
}

/** Register with a running instance, open browser, and exit. */
export async function joinRunningInstance(port: number, dataDir: string): Promise<void> {
  const absDataDir = resolve(dataDir);

  const res = await fetch(`http://localhost:${port}/api/projects/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dataDir: absDataDir }),
  });

  if (!res.ok) {
    const body = await res.json().catch(() => ({})) as { error?: string };
    console.error(`  Failed to register with running instance: ${body.error ?? 'Unknown error'}`);
    process.exit(1);
  }

  const project = await res.json() as { name: string; secret: string };
  const url = `http://localhost:${port}?project=${project.secret}`;
  console.log(`\n  Joined running Hot Sheet instance on port ${port}`);
  console.log(`  Project: ${project.name}`);
  console.log(`  ${url}\n`);

  const openCmd = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'start'
    : 'xdg-open';
  execFile(openCmd, [url]);
}
