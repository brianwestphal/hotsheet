/**
 * OS keychain access for storing plugin secrets.
 * Uses platform commands (no native Node dependencies):
 *   - macOS: `security` (Keychain Services)
 *   - Linux: `secret-tool` (libsecret / GNOME Keyring)
 *   - Windows: falls back to file storage (no keychain support yet)
 */
import { execFile } from 'child_process';
import { platform } from 'os';

const SERVICE_PREFIX = 'com.hotsheet.plugin';

function makeService(pluginId: string): string {
  return `${SERVICE_PREFIX}.${pluginId}`;
}

function exec(cmd: string, args: string[]): Promise<{ stdout: string; exitCode: number }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (error, stdout) => {
      resolve({ stdout: stdout.trim(), exitCode: error ? (error as { status?: number }).status ?? 1 : 0 });
    });
  });
}

// --- macOS ---

async function macGet(service: string, account: string): Promise<string | null> {
  const { stdout, exitCode } = await exec('security', [
    'find-generic-password', '-s', service, '-a', account, '-w',
  ]);
  return exitCode === 0 ? stdout : null;
}

async function macSet(service: string, account: string, password: string): Promise<boolean> {
  // Delete first (update not supported — add fails if exists)
  await exec('security', ['delete-generic-password', '-s', service, '-a', account]);
  const { exitCode } = await exec('security', [
    'add-generic-password', '-s', service, '-a', account, '-w', password, '-U',
  ]);
  return exitCode === 0;
}

async function macDelete(service: string, account: string): Promise<boolean> {
  const { exitCode } = await exec('security', [
    'delete-generic-password', '-s', service, '-a', account,
  ]);
  return exitCode === 0;
}

// --- Linux ---

async function linuxGet(service: string, account: string): Promise<string | null> {
  const { stdout, exitCode } = await exec('secret-tool', [
    'lookup', 'service', service, 'account', account,
  ]);
  return exitCode === 0 && stdout !== '' ? stdout : null;
}

async function linuxSet(service: string, account: string, password: string): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = execFile('secret-tool', [
      'store', '--label', `Hot Sheet: ${account}`, 'service', service, 'account', account,
    ], { timeout: 5000 }, (error) => {
      resolve(error == null);
    });
    // secret-tool reads the password from stdin
    proc.stdin?.write(password);
    proc.stdin?.end();
  });
}

async function linuxDelete(service: string, account: string): Promise<boolean> {
  const { exitCode } = await exec('secret-tool', [
    'clear', 'service', service, 'account', account,
  ]);
  return exitCode === 0;
}

// --- Public API ---

let _available: boolean | null = null;

/** Reset the cached availability probe. Tests only — the real process probes once. */
export function __resetKeychainAvailabilityCacheForTests(): void {
  _available = null;
}

/**
 * Linux: the keychain is usable only if `secret-tool` is installed AND a Secret
 * Service daemon (GNOME Keyring / KWallet) is running + unlocked. A bare
 * `which secret-tool` passes on a headless box with no daemon — then the first
 * write fails. So we verify the service actually works with a store→lookup→clear
 * round-trip on a throwaway sentinel (HS-9019). Returns false if the binary is
 * absent or the round-trip doesn't return what we stored.
 */
async function linuxKeychainWorks(): Promise<boolean> {
  const { exitCode } = await exec('which', ['secret-tool']);
  if (exitCode !== 0) return false;
  const service = `${SERVICE_PREFIX}.__probe__`;
  const account = '__availability__';
  const token = 'ok';
  try {
    if (!await linuxSet(service, account, token)) return false;
    return (await linuxGet(service, account)) === token;
  } catch {
    return false;
  } finally {
    await linuxDelete(service, account);
  }
}

/** Check if OS keychain is available and usable on this platform.
 *  On macOS, verifies the default keychain exists (not just that the security
 *  command works — a temp HOME has no user keychain and pops system dialogs).
 *  On Linux, verifies the Secret Service actually works, not just that the
 *  binary is present (HS-9019). Windows has no keychain path here yet. */
export async function isKeychainAvailable(): Promise<boolean> {
  if (_available !== null) return _available;
  const os = platform();
  if (os === 'darwin') {
    // `security default-keychain` fails if no user keychain exists (e.g., temp HOME in e2e tests).
    // This prevents system dialog popups from `add-generic-password` on missing keychains.
    const { exitCode } = await exec('security', ['default-keychain']);
    _available = exitCode === 0;
  } else if (os === 'linux') {
    _available = await linuxKeychainWorks();
  } else {
    _available = false;
  }
  return _available;
}

/** Get a secret from the OS keychain. Returns null if not found or unavailable. */
export async function keychainGet(pluginId: string, key: string): Promise<string | null> {
  if (!await isKeychainAvailable()) return null;
  const service = makeService(pluginId);
  const os = platform();
  try {
    if (os === 'darwin') return await macGet(service, key);
    if (os === 'linux') return await linuxGet(service, key);
  } catch {
    // Keychain error — fall back silently
  }
  return null;
}

/** Store a secret in the OS keychain. Returns true on success. */
export async function keychainSet(pluginId: string, key: string, value: string): Promise<boolean> {
  if (!await isKeychainAvailable()) return false;
  const service = makeService(pluginId);
  const os = platform();
  try {
    if (os === 'darwin') return await macSet(service, key, value);
    if (os === 'linux') return await linuxSet(service, key, value);
  } catch {
    // Keychain error — fall back silently
  }
  return false;
}

/** Delete a secret from the OS keychain. Returns true on success. */
export async function keychainDelete(pluginId: string, key: string): Promise<boolean> {
  if (!await isKeychainAvailable()) return false;
  const service = makeService(pluginId);
  const os = platform();
  try {
    if (os === 'darwin') return await macDelete(service, key);
    if (os === 'linux') return await linuxDelete(service, key);
  } catch {
    // Keychain error — fall back silently
  }
  return false;
}
