/**
 * HS-9133 — `open-in-file-manager.ts` platform branches. `child_process.execFile`
 * is mocked; `process.platform` is overridden per case.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openInFileManager, revealInFileManager } from './open-in-file-manager.js';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('child_process', () => ({ execFile: execFileMock }));

const realPlatform = process.platform;
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true });
}

beforeEach(() => { execFileMock.mockReset(); });
afterEach(() => { Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true }); });

describe('openInFileManager', () => {
  it('uses `open` on macOS', async () => {
    setPlatform('darwin');
    await openInFileManager('/some/dir');
    expect(execFileMock).toHaveBeenCalledWith('open', ['/some/dir']);
  });
  it('uses `explorer` on Windows', async () => {
    setPlatform('win32');
    await openInFileManager('C:\\dir');
    expect(execFileMock).toHaveBeenCalledWith('explorer', ['C:\\dir']);
  });
  it('uses `xdg-open` elsewhere (Linux)', async () => {
    setPlatform('linux');
    await openInFileManager('/some/dir');
    expect(execFileMock).toHaveBeenCalledWith('xdg-open', ['/some/dir']);
  });
});

describe('revealInFileManager', () => {
  it('uses `open -R` on macOS', async () => {
    setPlatform('darwin');
    await revealInFileManager('/a/b/file.png');
    expect(execFileMock).toHaveBeenCalledWith('open', ['-R', '/a/b/file.png']);
  });
  it('uses `explorer /select,` on Windows', async () => {
    setPlatform('win32');
    await revealInFileManager('C:\\a\\file.png');
    expect(execFileMock).toHaveBeenCalledWith('explorer', ['/select,', 'C:\\a\\file.png']);
  });
  it('opens the parent dir via `xdg-open` on Linux', async () => {
    setPlatform('linux');
    await revealInFileManager('/a/b/file.png');
    expect(execFileMock).toHaveBeenCalledWith('xdg-open', ['/a/b']);
  });
});
