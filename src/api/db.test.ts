/**
 * HS-8636 — db (recovery / snapshot / repair) typed-API module. Verifies the
 * callers hit the right path + method, unwrap the marker/backup wrappers, and
 * that the schemas accept a real payload / reject a malformed one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { type ApiCallOpts, type ApiTransport, setApiTransport } from './_runner.js';
import {
  dismissRecovery, findWorkingBackup, getRecoveryStatus, getResetwalAvailability,
  getSnapshotStatus, listCorruptClusters, probeCorruptCluster, RecoveryMarkerSchema,
  RepairResultSchema, ResetwalAvailabilitySchema, runResetwal,
} from './db.js';

const marker = { corruptPath: '/x/db-corrupt-1', recoveredAt: 'x', errorMessage: 'boom' };
const availability = { available: true, path: '/usr/bin/pg_resetwal', platform: 'darwin', installInstructions: { description: 'd', command: 'c', url: 'u' } };
const repair = { tier: '5min', filename: 'r.tar.gz', ticketCount: 5, sizeBytes: 200 };

let lastCall: { path: string; opts: ApiCallOpts } | undefined;
function stub(result: unknown): void {
  const t = vi.fn<ApiTransport>((path, opts) => { lastCall = { path, opts }; return Promise.resolve(result); });
  setApiTransport(t);
}
afterEach(() => { setApiTransport(null as unknown as ApiTransport); lastCall = undefined; });

describe('db schemas (HS-8636)', () => {
  it('accepts valid payloads and rejects malformed ones', () => {
    expect(RecoveryMarkerSchema.safeParse(marker).success).toBe(true);
    expect(RecoveryMarkerSchema.safeParse({ ...marker, restoredFrom: 'snapshot', restoredTicketCount: 9 }).success).toBe(true);
    expect(ResetwalAvailabilitySchema.safeParse(availability).success).toBe(true);
    expect(RepairResultSchema.safeParse(repair).success).toBe(true);
    expect(RecoveryMarkerSchema.safeParse({ recoveredAt: 'x', errorMessage: 'y' }).success).toBe(false); // missing corruptPath
    expect(ResetwalAvailabilitySchema.safeParse({ ...availability, available: 'yes' }).success).toBe(false);
  });
});

describe('db callers route to the right endpoint (HS-8636)', () => {
  it('getRecoveryStatus → GET /db/recovery-status, unwrapped (marker or null)', async () => {
    stub({ marker });
    expect(await getRecoveryStatus()).toEqual(marker);
    expect(lastCall?.path).toBe('/db/recovery-status');
    stub({ marker: null });
    expect(await getRecoveryStatus()).toBeNull();
  });

  it('dismissRecovery → POST /db/dismiss-recovery', async () => {
    stub({ ok: true });
    await dismissRecovery();
    expect(lastCall).toEqual({ path: '/db/dismiss-recovery', opts: { method: 'POST' } });
  });

  it('getSnapshotStatus → GET /db/snapshot-status', async () => {
    stub({ lastSnapshotAt: 123, lastSizeBytes: 456 });
    expect(await getSnapshotStatus()).toEqual({ lastSnapshotAt: 123, lastSizeBytes: 456 });
    expect(lastCall?.path).toBe('/db/snapshot-status');
  });

  it('findWorkingBackup → POST /db/repair/find-working-backup, unwrapped', async () => {
    const backup = { tier: '5min', filename: 'b.tar.gz', ticketCount: 1, createdAt: 'x' };
    stub({ backup });
    expect(await findWorkingBackup()).toEqual(backup);
    expect(lastCall).toEqual({ path: '/db/repair/find-working-backup', opts: { method: 'POST' } });
    stub({ backup: null });
    expect(await findWorkingBackup()).toBeNull();
  });

  it('getResetwalAvailability → GET /db/repair/pg-resetwal-availability', async () => {
    stub(availability);
    expect(await getResetwalAvailability()).toEqual(availability);
    expect(lastCall?.path).toBe('/db/repair/pg-resetwal-availability');
  });

  it('runResetwal → POST /db/repair/run-pg-resetwal', async () => {
    stub(repair);
    expect(await runResetwal()).toEqual(repair);
    expect(lastCall).toEqual({ path: '/db/repair/run-pg-resetwal', opts: { method: 'POST' } });
  });
});

/**
 * HS-9578 — the two path-taking callers must hand the transport an OBJECT.
 *
 * `client/api.tsx::api` does `JSON.stringify(opts.body)` itself, so a caller
 * that pre-encodes ships a doubly-encoded body: the server receives a JSON
 * *string*, `CorruptPathReqSchema.safeParse` fails, and the request 400s. These
 * two were the only callers in `src/api/*` that did it, which is why nothing
 * else showed the symptom — and it silently disabled the whole HS-9575 picker
 * (every probe read "checking…" forever, and Repair This One never ran).
 *
 * A shape assertion is the right guard here because the failure is invisible at
 * the type level: `ApiCallOpts.body` is `unknown`, so a string satisfies it.
 */
describe('path-taking repair callers send an unencoded body (HS-9578)', () => {
  it('probeCorruptCluster sends { corruptPath } as an object', async () => {
    stub({ recoverableTicketCount: 12 });
    expect(await probeCorruptCluster('/x/db-corrupt-1')).toBe(12);
    expect(lastCall?.path).toBe('/db/repair/probe-corrupt-cluster');
    expect(lastCall?.opts.body).toEqual({ corruptPath: '/x/db-corrupt-1' });
    expect(typeof lastCall?.opts.body).not.toBe('string');
  });

  it('runResetwal sends { corruptPath } as an object when given one', async () => {
    stub(repair);
    await runResetwal('/x/db-corrupt-2');
    expect(lastCall?.opts.body).toEqual({ corruptPath: '/x/db-corrupt-2' });
    expect(typeof lastCall?.opts.body).not.toBe('string');
  });

  it('runResetwal still sends NO body when no path is chosen', async () => {
    // The pre-HS-9575 fallback: the server then uses the recovery marker.
    stub(repair);
    await runResetwal();
    expect(lastCall?.opts.body).toBeUndefined();
  });

  it('listCorruptClusters → GET /db/repair/corrupt-clusters, unwrapped', async () => {
    const cluster = {
      path: '/x/db-corrupt-1', name: 'db-corrupt-1', modifiedAt: 'x',
      sizeBytes: 10, looksLikeCluster: true, recoverableTicketCount: null,
    };
    stub({ clusters: [cluster] });
    expect(await listCorruptClusters()).toEqual([cluster]);
    expect(lastCall?.path).toBe('/db/repair/corrupt-clusters');
  });
});
