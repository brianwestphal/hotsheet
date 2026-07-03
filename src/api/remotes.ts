// HS-9302 (docs/112 §112.3) — typed callers for the machine-global remotes store
// (`GET`/`PUT /api/remotes`). The wire shape is the SSOT `RemotesFileSchema` in
// `routes/validation.ts` (shared with the server fs module `src/remotes.ts`).

import { type RemotesFile, RemotesFileSchema } from '../routes/validation.js';
import { apiCall } from './_runner.js';

export type { RemoteProject, RemoteServer, RemotesFile } from '../routes/validation.js';

/** GET `/remotes` → the mounted remote servers + their projects. */
export async function getRemotes(): Promise<RemotesFile> {
  return apiCall(RemotesFileSchema, '/remotes');
}

/** PUT `/remotes` → replace the whole store (caller read-modify-writes). */
export async function putRemotes(next: RemotesFile): Promise<RemotesFile> {
  return apiCall(RemotesFileSchema, '/remotes', { method: 'PUT', body: next });
}
