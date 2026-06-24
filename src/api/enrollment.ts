/**
 * HS-8994 — typed wire schemas + callers for mTLS client-cert enrollment
 * (`src/routes/enrollment.ts`, §94.4.2 Phase 1). Mint a CA-signed client `.p12`
 * for a named device, sign an externally-generated CSR (loopback-only), list
 * enrolled devices, and revoke one. Metadata-only over the wire except the
 * minted `.p12` bytes (base64) + a signed CSR's cert PEM. See docs/94.
 */
import { z } from 'zod';

import { apiCall } from './_runner.js';

// --- Wire shapes ---

export const EnrolledDeviceSchema = z.object({
  clientId: z.string(),
  label: z.string(),
  serial: z.string(),
  fingerprint: z.string(),
  enrolledAt: z.string(),
  expiresAt: z.string(),
  revoked: z.boolean(),
  revokedAt: z.string().optional(),
});
export type EnrolledDevice = z.infer<typeof EnrolledDeviceSchema>;

export const DevicesListResSchema = z.object({ devices: z.array(EnrolledDeviceSchema) });
export const DeviceResSchema = z.object({ device: EnrolledDeviceSchema });

export const MintDeviceReqSchema = z.object({
  label: z.string().min(1),
  /** Password protecting the exported `.p12` (required by PKCS#12). */
  password: z.string().min(1),
});
export type MintDeviceReq = z.infer<typeof MintDeviceReqSchema>;

export const MintDeviceResSchema = z.object({
  device: EnrolledDeviceSchema,
  /** The password-protected `.p12` bundle, base64-encoded. */
  p12Base64: z.string(),
  filename: z.string(),
});
export type MintDeviceRes = z.infer<typeof MintDeviceResSchema>;

export const SignCsrReqSchema = z.object({
  csrPem: z.string().min(1),
  label: z.string().min(1),
});
export type SignCsrReq = z.infer<typeof SignCsrReqSchema>;

export const SignCsrResSchema = z.object({
  device: EnrolledDeviceSchema,
  certPem: z.string(),
});
export type SignCsrRes = z.infer<typeof SignCsrResSchema>;

// HS-8996 — QR pairing (§94.4.2 Phase 2). `start` (loopback-only) issues a
// short-lived single-use token for the QR; `complete` is called by the scanning
// device with the token + its CSR (the token is the gate, not loopback).
export const PairStartResSchema = z.object({
  token: z.string(),
  expiresAt: z.number(),
});
export type PairStartRes = z.infer<typeof PairStartResSchema>;

export const PairCompleteReqSchema = z.object({
  token: z.string().min(1),
  csrPem: z.string().min(1),
  label: z.string().min(1),
});
export type PairCompleteReq = z.infer<typeof PairCompleteReqSchema>;

export const PairCompleteResSchema = z.object({
  device: EnrolledDeviceSchema,
  certPem: z.string(),
});
export type PairCompleteRes = z.infer<typeof PairCompleteResSchema>;

// --- Typed callers ---

export async function listEnrolledDevices(): Promise<EnrolledDevice[]> {
  return (await apiCall(DevicesListResSchema, '/auth/devices')).devices;
}

export async function mintDeviceP12(req: MintDeviceReq): Promise<MintDeviceRes> {
  return apiCall(MintDeviceResSchema, '/auth/devices/mint', { method: 'POST', body: req });
}

export async function signDeviceCsr(req: SignCsrReq): Promise<SignCsrRes> {
  return apiCall(SignCsrResSchema, '/auth/devices/sign-csr', { method: 'POST', body: req });
}

export async function revokeEnrolledDevice(clientId: string): Promise<EnrolledDevice> {
  return (await apiCall(DeviceResSchema, `/auth/devices/${encodeURIComponent(clientId)}/revoke`, { method: 'POST' })).device;
}

export async function startPairing(): Promise<PairStartRes> {
  return apiCall(PairStartResSchema, '/auth/pair/start', { method: 'POST' });
}

export async function completePairing(req: PairCompleteReq): Promise<PairCompleteRes> {
  return apiCall(PairCompleteResSchema, '/auth/pair/complete', { method: 'POST', body: req });
}
