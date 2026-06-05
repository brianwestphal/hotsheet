/**
 * §78 / HS-8751 — announcer key resolution now reads from the global registry
 * via the per-project `announcer_ai_key_id` selection (env var still overrides).
 * The registry + settings layers are mocked; this asserts the wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let settings: Record<string, string> = {};
vi.mock('../db/queries.js', () => ({
  getSettings: vi.fn(() => Promise.resolve(settings)),
  updateSetting: vi.fn((k: string, v: string) => { settings[k] = v; return Promise.resolve(); }),
}));

const resolveKeyValueByType = vi.fn<(type: string, id?: string) => Promise<unknown>>();
vi.mock('../secret-keys.js', () => ({ resolveKeyValueByType: (type: string, id?: string) => resolveKeyValueByType(type, id) }));

const { getAnnouncerKeyId, hasAnnouncerKey, resolveAnnouncerKey, setAnnouncerKeyId } = await import('./key.js');

beforeEach(() => {
  settings = {};
  resolveKeyValueByType.mockReset();
  delete process.env.ANTHROPIC_API_KEY;
});
afterEach(() => { delete process.env.ANTHROPIC_API_KEY; });

describe('resolveAnnouncerKey (HS-8751)', () => {
  it('env var overrides the registry', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-env';
    expect(await resolveAnnouncerKey()).toBe('sk-env');
    expect(resolveKeyValueByType).not.toHaveBeenCalled();
  });

  it('passes the project-selected key id to the registry', async () => {
    settings['announcer_ai_key_id'] = 'key-7';
    resolveKeyValueByType.mockResolvedValue({ value: 'sk-selected', meta: { id: 'key-7' } });
    expect(await resolveAnnouncerKey()).toBe('sk-selected');
    expect(resolveKeyValueByType).toHaveBeenCalledWith('anthropic_api_key', 'key-7');
  });

  it('with no selection, asks for the default (undefined selection)', async () => {
    resolveKeyValueByType.mockResolvedValue({ value: 'sk-default', meta: { id: 'first' } });
    expect(await resolveAnnouncerKey()).toBe('sk-default');
    expect(resolveKeyValueByType).toHaveBeenCalledWith('anthropic_api_key', undefined);
  });

  it('null when the registry has nothing', async () => {
    resolveKeyValueByType.mockResolvedValue(null);
    expect(await resolveAnnouncerKey()).toBeNull();
    expect(await hasAnnouncerKey()).toBe(false);
  });

  it('get/set the per-project selection round-trips through settings', async () => {
    expect(await getAnnouncerKeyId()).toBeNull();
    await setAnnouncerKeyId('key-9');
    expect(settings['announcer_ai_key_id']).toBe('key-9');
    expect(await getAnnouncerKeyId()).toBe('key-9');
    await setAnnouncerKeyId(null);
    expect(settings['announcer_ai_key_id']).toBe('');
    expect(await getAnnouncerKeyId()).toBeNull();
  });
});
