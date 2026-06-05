/**
 * HS-8751 — typed wire schemas + callers for the global API-key registry
 * (`src/routes/keys.ts`). Metadata only ever crosses the wire — the secret
 * value is write-only (sent on create/update, never returned). See
 * docs/79-api-keys.md.
 */
import { z } from 'zod';

import { KeyTypeSchema, type SecretKeyMeta, SecretKeyMetaSchema } from '../routes/validation.js';
import { apiCall, type OkResponse, OkResponseSchema } from './_runner.js';

export type { SecretKeyMeta };
export { KeyTypeSchema };
export type KeyType = z.infer<typeof KeyTypeSchema>;

// --- Wire shapes ---

export const KeysListResSchema = z.object({ keys: z.array(SecretKeyMetaSchema) });
export const KeyResSchema = z.object({ key: SecretKeyMetaSchema });

export const CreateKeyReqSchema = z.object({
  type: KeyTypeSchema,
  name: z.string().min(1),
  value: z.string().min(1),
});
export type CreateKeyReq = z.infer<typeof CreateKeyReqSchema>;

export const UpdateKeyReqSchema = z.object({
  type: KeyTypeSchema.optional(),
  name: z.string().min(1).optional(),
  /** New secret value; blank/omitted leaves the stored secret untouched. */
  value: z.string().optional(),
});
export type UpdateKeyReq = z.infer<typeof UpdateKeyReqSchema>;

// --- Typed callers ---

export async function listKeys(): Promise<SecretKeyMeta[]> {
  return (await apiCall(KeysListResSchema, '/keys')).keys;
}

export async function createKey(req: CreateKeyReq): Promise<SecretKeyMeta> {
  return (await apiCall(KeyResSchema, '/keys', { method: 'POST', body: req })).key;
}

export async function updateKey(id: string, req: UpdateKeyReq): Promise<SecretKeyMeta> {
  return (await apiCall(KeyResSchema, `/keys/${encodeURIComponent(id)}`, { method: 'PUT', body: req })).key;
}

export async function deleteKey(id: string): Promise<OkResponse> {
  return apiCall(OkResponseSchema, `/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
