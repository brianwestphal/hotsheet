/**
 * HS-8994 — per-project enrolled-device registry for the mTLS epic (§94). When a
 * client cert is minted (`.p12`) or signed from a CSR, its metadata is recorded
 * here so the Settings UI can list devices and a revocation check (sub-ticket 4
 * / HS-8995) can match a connecting cert by serial or fingerprint.
 *
 * Stored as `<dataDir>/auth-devices.json` — gitignored (the HS-8989 rule ignores
 * everything under `.hotsheet/` except `settings.json`), machine-local, and
 * per-project (the CA itself is per-project too, §94 / `ca.ts`). Metadata only;
 * no private keys (the client keeps its key — for a minted `.p12` we hand the key
 * over in the bundle and never store it).
 */
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { z } from 'zod';

const EnrolledDeviceSchema = z.object({
  clientId: z.string(),
  label: z.string(),
  /** Cert serial (hex) — a stable revocation key. */
  serial: z.string(),
  /** Cert SHA-256 fingerprint — the alternate revocation key. */
  fingerprint: z.string(),
  enrolledAt: z.string(),
  /** Cert `notAfter` (ISO) — shown in the UI; expired certs are rejected by TLS. */
  expiresAt: z.string(),
  revoked: z.boolean(),
  revokedAt: z.string().optional(),
});

export type EnrolledDevice = z.infer<typeof EnrolledDeviceSchema>;

const DeviceFileSchema = z.object({
  devices: z.array(EnrolledDeviceSchema).default([]),
}).loose();

export function deviceRegistryPath(dataDir: string): string {
  return join(dataDir, 'auth-devices.json');
}

/** Read the registry. Returns `[]` when absent / unreadable / malformed. */
export function listDevices(dataDir: string): EnrolledDevice[] {
  const path = deviceRegistryPath(dataDir);
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const parsed = DeviceFileSchema.safeParse(raw);
    return parsed.success ? parsed.data.devices : [];
  } catch (err: unknown) {
    if (err instanceof Error && (err as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[auth] Failed to read auth-devices.json in ${dataDir}: ${err.message}`);
    }
    return [];
  }
}

function writeDevices(dataDir: string, devices: EnrolledDevice[]): void {
  writeFileSync(deviceRegistryPath(dataDir), JSON.stringify({ devices }, null, 2) + '\n', 'utf-8');
}

/** Record a freshly-enrolled device. Replaces any existing entry with the same
 *  `clientId` (re-enrollment of the same device rotates its cert). */
export function addDevice(dataDir: string, device: EnrolledDevice): void {
  const devices = listDevices(dataDir).filter(d => d.clientId !== device.clientId);
  devices.push(device);
  writeDevices(dataDir, devices);
}

/** Flip a device to revoked (the data action; connect-time enforcement is
 *  HS-8995). Returns the updated device, or null if no device has that id. */
export function revokeDevice(dataDir: string, clientId: string, revokedAt: string): EnrolledDevice | null {
  const devices = listDevices(dataDir);
  const idx = devices.findIndex(d => d.clientId === clientId);
  if (idx === -1) return null;
  const updated: EnrolledDevice = { ...devices[idx], revoked: true, revokedAt };
  devices[idx] = updated;
  writeDevices(dataDir, devices);
  return updated;
}

/** Whether a connecting cert (by serial OR fingerprint) belongs to a revoked
 *  device. The seed of the sub-ticket-4 connect-time revocation check. */
export function isRevoked(dataDir: string, match: { serial?: string; fingerprint?: string }): boolean {
  return listDevices(dataDir).some(d =>
    d.revoked && (
      (match.serial !== undefined && d.serial === match.serial) ||
      (match.fingerprint !== undefined && d.fingerprint === match.fingerprint)
    ));
}
