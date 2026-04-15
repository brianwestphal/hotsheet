/** Common MIME type mappings shared across server, attachments, and plugins. */
export const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
};

/** Look up a MIME type by file extension (with or without leading dot). */
export function getMimeType(ext: string): string {
  const key = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  return MIME_TYPES[key] ?? 'application/octet-stream';
}
