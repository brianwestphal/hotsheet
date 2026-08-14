/**
 * HS-9662 / docs/136 — detached PTY-broker process entry.
 *
 * Launched by the node server (`brokerMode.spawnDetachedBroker`) as a detached
 * child: `node [--import tsx] ptyBrokerEntry <socketPath>`. Binds the control
 * socket and owns all terminal PTYs until an explicit shutdown / lost lease.
 */
import { existsSync, unlinkSync } from 'fs';

import { PtyBroker } from './ptyBroker.js';

async function main(): Promise<void> {
  const socketPath = process.argv[2];
  if (!socketPath) {
    console.error('[pty-broker] usage: ptyBrokerEntry <socketPath>');
    process.exit(2);
  }

  const broker = new PtyBroker();

  const bind = async (): Promise<boolean> => {
    try {
      await broker.listen(socketPath);
      return true;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'EADDRINUSE') {
        // Either a live broker already owns it (then we should exit and let the
        // client use that one), or it's a stale socket from a dead broker. Try to
        // unlink + rebind once; if it rebinds, the old one was stale.
        try { if (existsSync(socketPath)) unlinkSync(socketPath); } catch { /* ignore */ }
        try { await broker.listen(socketPath); return true; } catch { return false; }
      }
      console.error('[pty-broker] listen failed:', e instanceof Error ? e.message : String(e));
      return false;
    }
  };

  if (!(await bind())) {
    // A live broker already owns the socket — nothing to do.
    process.exit(0);
  }
  console.error(`[pty-broker] listening on ${socketPath} (pid ${String(process.pid)})`);

  // Explicit signals → kill all PTYs + exit. (A client merely disconnecting does
  // NOT kill — that's the accidental-death survival path handled by the lease.)
  const quit = (): void => { broker.shutdown(); process.exit(0); };
  process.on('SIGTERM', quit);
  process.on('SIGINT', quit);
}

void main();
