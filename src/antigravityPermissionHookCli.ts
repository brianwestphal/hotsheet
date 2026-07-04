// HS-9327 — real-IO wiring for the Antigravity PreToolUse permission hook (the pure
// logic lives in `antigravityPermissionHook.ts`). Invoked as `<cli> __agy-permission-hook`
// by agy before each tool call; resolves the channel server for the CWD project and
// runs the interactive permission flow, returning the process exit code.
import { randomUUID } from 'crypto';
import { join } from 'path';

import { runPermissionHook } from './antigravityPermissionHook.js';
import { getChannelPort } from './channel-config.js';

/** Read all of stdin (agy pipes the PreToolUse payload). Resolves on `end`, on
 *  error, or after a short cap so a hook with nothing piped can't hang. */
function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    const stdin = process.stdin;
    stdin.setEncoding('utf-8');
    stdin.on('data', (c: string | Buffer) => { data += typeof c === 'string' ? c : c.toString('utf-8'); });
    stdin.on('end', () => resolve(data));
    stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

/** Run the permission hook with real IO. Returns 0 (allow) / 2 (deny). */
export function runAgyPermissionHookCli(): Promise<number> {
  const dataDir = join(process.cwd(), '.hotsheet'); // agy runs the hook in the project dir
  return runPermissionHook({
    readStdin,
    channelBaseUrl: () => {
      const port = getChannelPort(dataDir);
      return port !== null && port > 0 ? `http://localhost:${String(port)}` : null;
    },
    writeStdout: (s) => { process.stdout.write(s); },
    fetchFn: fetch,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    newRequestId: () => randomUUID(),
  });
}
