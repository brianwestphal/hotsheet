import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetEmptyClusterGuardForTests,
  clearClusterCreatedEmpty,
  noteClusterCreatedEmpty,
  readContentMarker,
  shouldBlockArtifactWrite,
  wasClusterCreatedEmpty,
  writeContentMarker,
} from './emptyClusterGuard.js';

let dataDir: string;

beforeEach(() => {
  _resetEmptyClusterGuardForTests();
  dataDir = mkdtempSync(join(tmpdir(), 'hs-empty-guard-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('shouldBlockArtifactWrite', () => {
  it('blocks the 2026-08-04 incident: a fresh empty cluster over a project that had data', () => {
    expect(shouldBlockArtifactWrite({ createdEmpty: true, liveTicketCount: 0, priorTicketCount: 429 })).toBe(true);
  });

  it('allows a brand-new project, which is empty for the innocent reason', () => {
    // Same first two facts as the incident. The third is what distinguishes them,
    // and getting this wrong would mean a new project never gets a first backup.
    expect(shouldBlockArtifactWrite({ createdEmpty: true, liveTicketCount: 0, priorTicketCount: 0 })).toBe(false);
  });

  it('allows a user who legitimately deleted every ticket', () => {
    // Empty, and the project certainly had data — but the cluster was OPENED, not
    // created, so this is a real state the user produced and must be backed up.
    expect(shouldBlockArtifactWrite({ createdEmpty: false, liveTicketCount: 0, priorTicketCount: 429 })).toBe(false);
  });

  it('allows a restored cluster: created this process, but it has content', () => {
    expect(shouldBlockArtifactWrite({ createdEmpty: true, liveTicketCount: 429, priorTicketCount: 429 })).toBe(false);
  });

  it('allows the ordinary case', () => {
    expect(shouldBlockArtifactWrite({ createdEmpty: false, liveTicketCount: 430, priorTicketCount: 429 })).toBe(false);
  });
});

describe('content marker', () => {
  it('round-trips the count', () => {
    writeContentMarker(dataDir, 429);
    expect(readContentMarker(dataDir)?.lastTicketCount).toBe(429);
  });

  it('reads as null when absent — a project with no history blocks nothing', () => {
    expect(readContentMarker(dataDir)).toBeNull();
  });

  it('reads as null on a corrupt marker rather than throwing', () => {
    // Fails OPEN by design: a marker problem must never stop a healthy project
    // from being backed up.
    writeFileSync(join(dataDir, '.db-content-marker.json'), '{ not json');
    expect(readContentMarker(dataDir)).toBeNull();
  });

  it('reads as null when the shape is wrong', () => {
    writeFileSync(join(dataDir, '.db-content-marker.json'), JSON.stringify({ lastTicketCount: 'many' }));
    expect(readContentMarker(dataDir)).toBeNull();
  });

  it('is written to dataDir, never to a configured backupDir', () => {
    // The marker is read on the artifact-write path; putting it on a cloud
    // backupDir would reintroduce the HS-9527 blocking-read hazard.
    writeContentMarker(dataDir, 12);
    expect(existsSync(join(dataDir, '.db-content-marker.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(dataDir, '.db-content-marker.json'), 'utf-8'))).toMatchObject({
      lastTicketCount: 12,
    });
  });
});

describe('created-empty flag', () => {
  it('tracks per dataDir, so one broken project does not gate another', () => {
    noteClusterCreatedEmpty('/a');
    expect(wasClusterCreatedEmpty('/a')).toBe(true);
    expect(wasClusterCreatedEmpty('/b')).toBe(false);
  });

  it('clears once the cluster has content again', () => {
    noteClusterCreatedEmpty('/a');
    clearClusterCreatedEmpty('/a');
    expect(wasClusterCreatedEmpty('/a')).toBe(false);
  });
});

describe('the incident, as a sequence', () => {
  // Coverage is a floor: each predicate branch above passes in isolation. What
  // actually failed on 2026-08-04 was a SEQUENCE — healthy writes, a crash, a
  // fresh cluster, then writes again — so walk it end to end.
  it('protects the artifact, then releases the guard after a restore', () => {
    // 1. Healthy: backups run and record what they captured.
    writeContentMarker(dataDir, 429);

    // 2. Recovery crashes (HS-9572); the next start creates a cluster from nothing.
    noteClusterCreatedEmpty(dataDir);

    // 3. The snapshot/backup writers must refuse while it holds nothing.
    const prior = readContentMarker(dataDir)?.lastTicketCount ?? 0;
    expect(shouldBlockArtifactWrite({ createdEmpty: true, liveTicketCount: 0, priorTicketCount: prior })).toBe(true);

    // 4. The user restores. `checkArtifactGuard` clears the flag on any nonzero
    //    count; model that here, then confirm writing resumes.
    clearClusterCreatedEmpty(dataDir);
    expect(shouldBlockArtifactWrite({ createdEmpty: false, liveTicketCount: 429, priorTicketCount: prior })).toBe(false);

    // 5. And the marker advances again with the restored content.
    writeContentMarker(dataDir, 429);
    expect(readContentMarker(dataDir)?.lastTicketCount).toBe(429);
  });

  it('does not re-arm on a later restart once the cluster is populated', () => {
    // The flag is process-scoped: a restart that OPENS the restored cluster
    // never calls noteClusterCreatedEmpty, so the guard is simply not armed.
    writeContentMarker(dataDir, 429);
    _resetEmptyClusterGuardForTests();
    expect(wasClusterCreatedEmpty(dataDir)).toBe(false);
    expect(shouldBlockArtifactWrite({
      createdEmpty: wasClusterCreatedEmpty(dataDir),
      liveTicketCount: 429,
      priorTicketCount: 429,
    })).toBe(false);
  });
});
