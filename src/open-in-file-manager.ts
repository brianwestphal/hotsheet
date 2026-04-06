import { dirname } from 'path';

/**
 * Open a directory (or file's parent directory) in the OS file manager.
 */
export async function openInFileManager(dirPath: string): Promise<void> {
  const { execFile } = await import('child_process');
  const platform = process.platform;
  if (platform === 'darwin') {
    execFile('open', [dirPath]);
  } else if (platform === 'win32') {
    execFile('explorer', [dirPath]);
  } else {
    execFile('xdg-open', [dirPath]);
  }
}

/**
 * Reveal a specific file in the OS file manager (highlight it in the folder).
 * On macOS uses `open -R`, on Windows uses `explorer /select,`, on Linux
 * falls back to opening the parent directory.
 */
export async function revealInFileManager(filePath: string): Promise<void> {
  const { execFile } = await import('child_process');
  const platform = process.platform;
  if (platform === 'darwin') {
    execFile('open', ['-R', filePath]);
  } else if (platform === 'win32') {
    execFile('explorer', ['/select,', filePath]);
  } else {
    execFile('xdg-open', [dirname(filePath)]);
  }
}
