// HS-9330 — the main-server ACP permission bridge (store + Promise resolver).
import { afterEach, describe, expect, it } from 'vitest';

import type { AcpPermissionOption } from './acpMapping.js';
import {
  _acpPendingCountForTesting, _resetAcpPermissionsForTesting,
  dismissAcpPermission, hasAcpPermission, injectAcpPermission,
  pendingAcpPermissionForSecret, resolveAcpPermission,
} from './acpPermissionBridge.js';

const OPTIONS: AcpPermissionOption[] = [
  { optionId: 'a', name: 'Allow', kind: 'allow_once' },
  { optionId: 'r', name: 'Reject', kind: 'reject_once' },
];

afterEach(() => { _resetAcpPermissionsForTesting(); });

describe('injectAcpPermission (HS-9330)', () => {
  it('registers a pending permission surfaced by secret + a unique request_id', () => {
    const { request_id } = injectAcpPermission({
      secret: 'sek-1', tool_name: 'read_file', description: 'Read /etc/hosts', options: OPTIONS,
    });
    expect(request_id).toMatch(/^acp-perm-\d+$/);
    expect(hasAcpPermission(request_id)).toBe(true);
    expect(_acpPendingCountForTesting()).toBe(1);
    const pending = pendingAcpPermissionForSecret('sek-1');
    expect(pending?.request_id).toBe(request_id);
    expect(pending?.tool_name).toBe('read_file');
    expect(pending?.options).toEqual(OPTIONS);
    // a different secret sees nothing
    expect(pendingAcpPermissionForSecret('other')).toBeNull();
  });

  it('mints distinct request_ids for successive injects', () => {
    const a = injectAcpPermission({ secret: 's', tool_name: 't', description: 'd', options: OPTIONS });
    const b = injectAcpPermission({ secret: 's', tool_name: 't', description: 'd', options: OPTIONS });
    expect(a.request_id).not.toBe(b.request_id);
    expect(_acpPendingCountForTesting()).toBe(2);
    // pendingAcpPermissionForSecret returns the FIRST (oldest) for the secret
    expect(pendingAcpPermissionForSecret('s')?.request_id).toBe(a.request_id);
  });
});

describe('resolveAcpPermission (HS-9330)', () => {
  it('resolves the injected promise with the chosen option + clears the pending', async () => {
    const { request_id, promise } = injectAcpPermission({
      secret: 's', tool_name: 't', description: 'd', options: OPTIONS,
    });
    expect(resolveAcpPermission(request_id, { optionId: 'a' })).toBe(true);
    await expect(promise).resolves.toEqual({ optionId: 'a' });
    // pending cleared; a second resolve is a no-op false (idempotent)
    expect(hasAcpPermission(request_id)).toBe(false);
    expect(_acpPendingCountForTesting()).toBe(0);
    expect(resolveAcpPermission(request_id, { optionId: 'a' })).toBe(false);
  });

  it('returns false for an unknown request_id (falls through to the Claude path)', () => {
    expect(resolveAcpPermission('acp-perm-999', { optionId: 'a' })).toBe(false);
    expect(resolveAcpPermission('claude-uuid-abc', { optionId: 'a' })).toBe(false);
  });
});

describe('dismissAcpPermission (HS-9330)', () => {
  it('resolves the promise as cancelled + clears the pending', async () => {
    const { request_id, promise } = injectAcpPermission({
      secret: 's', tool_name: 't', description: 'd', options: OPTIONS,
    });
    expect(dismissAcpPermission(request_id)).toBe(true);
    await expect(promise).resolves.toEqual({ cancelled: true });
    expect(hasAcpPermission(request_id)).toBe(false);
  });
});
