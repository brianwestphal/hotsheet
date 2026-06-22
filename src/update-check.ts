import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { get } from 'https';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { globalHotsheetDir } from './global-dir.js';
import { PackageVersionSchema, parseJsonOrNull } from './schemas.js';

// HS-8920 — resolved lazily (functions, not import-time consts) so the
// `HOTSHEET_HOME` relocation is honored regardless of when this module loads.
function dataDir(): string { return globalHotsheetDir(); }
function checkFile(): string { return join(dataDir(), 'last-update-check'); }
const PACKAGE_NAME = 'hotsheet';

function getCurrentVersion(): string {
  try {
    // Works both in dev (src/) and built (dist/) — package.json is always one dir up
    const dir = dirname(fileURLToPath(import.meta.url));
    // HS-8567 — zod-validate the package.json read at the parse boundary.
    const pkg = parseJsonOrNull(PackageVersionSchema, readFileSync(join(dir, '..', 'package.json'), 'utf-8'));
    return pkg !== null ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function getLastCheckDate(): string | null {
  try {
    if (existsSync(checkFile())) {
      return readFileSync(checkFile(), 'utf-8').trim();
    }
  } catch { /* ignore */ }
  return null;
}

function saveCheckDate(): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(checkFile(), new Date().toISOString().slice(0, 10), 'utf-8');
}

function isFirstUseToday(): boolean {
  const last = getLastCheckDate();
  if (last === null) return true;
  const today = new Date().toISOString().slice(0, 10);
  return last !== today;
}

function fetchLatestVersion(): Promise<string | null> {
  return new Promise((resolve) => {
    const req = get(`https://registry.npmjs.org/${PACKAGE_NAME}/latest`, { timeout: 5000 }, (res) => {
      if (res.statusCode !== 200) {
        resolve(null);
        return;
      }
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        // HS-8567 — zod-validate the npm registry response.
        const parsed = parseJsonOrNull(PackageVersionSchema, data);
        resolve(parsed !== null ? parsed.version : null);
      });
    });
    req.on('error', () => { resolve(null); });
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

function detectUpgradeCommand(): string {
  const binPath = process.argv[1] || '';

  if (binPath.includes('/.bun/') || binPath.includes('/bun/')) {
    return `bun update -g ${PACKAGE_NAME}`;
  }
  if (binPath.includes('/.pnpm/') || binPath.includes('/pnpm/')) {
    return `pnpm update -g ${PACKAGE_NAME}`;
  }
  if (binPath.includes('/.yarn/') || binPath.includes('/yarn/')) {
    return `yarn global upgrade ${PACKAGE_NAME}`;
  }

  return `npm update -g ${PACKAGE_NAME}`;
}

/** Compare two dotted version strings by their first three numeric components.
 *  Returns -1 when current is older than latest, 0 when equal over those
 *  components, or 1 when current is newer. Non-numeric / missing components are
 *  treated as 0 — so a pre-release suffix like `1.2.3-beta` parses its patch
 *  component to 0 and therefore sorts as `1.2.0` (below `1.2.3`). npm registry
 *  versions are clean `x.y.z`, so that edge doesn't arise in practice. Exported
 *  for unit testing. */
export function compareVersions(current: string, latest: string): number {
  const a = current.split('.').map(Number);
  const b = latest.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) < (b[i] || 0)) return -1;
    if ((a[i] || 0) > (b[i] || 0)) return 1;
  }
  return 0;
}

export async function checkForUpdates(force: boolean): Promise<void> {
  if (!force && !isFirstUseToday()) return;

  const current = getCurrentVersion();
  const latest = await fetchLatestVersion();

  saveCheckDate();

  if (latest === null || compareVersions(current, latest) >= 0) return;

  const cmd = detectUpgradeCommand();
  const updateLine = `Update available: ${current} → ${latest}`;
  const cmdLine = `Run: ${cmd}`;
  const width = Math.max(updateLine.length, cmdLine.length) + 4;
  const pad = (text: string, visLen: number) => text + ' '.repeat(Math.max(0, width - visLen));

  const border = '─'.repeat(width);
  const empty = ' '.repeat(width);

  console.log('');
  console.log(`  ┌${border}┐`);
  console.log(`  │${empty}│`);
  console.log(`  │  ${pad(`Update available: ${current} → \x1b[32m${latest}\x1b[0m`, updateLine.length + 2)}│`);
  console.log(`  │${empty}│`);
  console.log(`  │  ${pad(`Run: \x1b[36m${cmd}\x1b[0m`, cmdLine.length + 2)}│`);
  console.log(`  │${empty}│`);
  console.log(`  └${border}┘`);
  console.log('');
}
