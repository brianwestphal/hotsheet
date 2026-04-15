import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { z } from 'zod';

function getProjectListPath(): string {
  return join(homedir(), '.hotsheet', 'projects.json');
}

/** Read the persisted list of project dataDirs. */
export function readProjectList(): string[] {
  const path = getProjectListPath();
  if (!existsSync(path)) return [];
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf-8'));
    const result = z.array(z.string()).safeParse(raw);
    return result.success ? result.data : [];
  } catch {
    return [];
  }
}

/** Save the list of project dataDirs. */
function writeProjectList(dataDirs: string[]): void {
  const dir = join(homedir(), '.hotsheet');
  mkdirSync(dir, { recursive: true });
  writeFileSync(getProjectListPath(), JSON.stringify(dataDirs, null, 2));
}

/** Add a dataDir to the persisted list (if not already present). */
export function addToProjectList(dataDir: string): void {
  const abs = resolve(dataDir);
  const list = readProjectList();
  if (!list.includes(abs)) {
    list.push(abs);
    writeProjectList(list);
  }
}

/** Remove a dataDir from the persisted list. */
export function removeFromProjectList(dataDir: string): void {
  const abs = resolve(dataDir);
  const list = readProjectList().filter(d => d !== abs);
  writeProjectList(list);
}

/** Reorder the persisted list to match the given order of dataDirs. */
export function reorderProjectList(dataDirs: string[]): void {
  const absOrder = dataDirs.map(d => resolve(d));
  writeProjectList(absOrder);
}
