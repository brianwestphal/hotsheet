/**
 * HS-9662 / docs/136 — detached PTY-broker process entry.
 *
 * Launched by the node server (`brokerMode.spawnDetachedBroker`) as a detached
 * child: `node [--import tsx] ptyBrokerEntry <socketPath>`. Binds the control
 * socket and owns all terminal PTYs until an explicit shutdown / lost lease.
 */
import { PtyBroker } from './ptyBroker.js';

async function main(): Promise<void> {
  const socketPath = process.argv[2];
  if (!socketPath) {
    console.error('[pty-broker] usage: ptyBrokerEntry <socketPath>');
    process.exit(2);
  }

  const broker = new PtyBroker();

  // HS-9694 — `bind` resolves an EADDRINUSE conflict SAFELY: it defers to a LIVE
  // broker (never unlinking its socket, which would orphan its PTYs) and only
  // unlinks + rebinds a genuinely stale socket. See PtyBroker.bind.
  if (!(await broker.bind(socketPath))) {
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
