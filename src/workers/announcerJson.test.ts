/**
 * HS-9133 — provider routing for the shared structured-JSON announcer call
 * (`workers/announcerJson.ts`). All provider deps + the Anthropic SDK are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callAnnouncerJson } from './announcerJson.js';

const m = vi.hoisted(() => ({
  resolveAnnouncerModel: vi.fn<() => Promise<string>>(),
  providerForModel: vi.fn<(model: string) => string>(),
  runApple: vi.fn<() => Promise<string | null>>(),
  runLocal: vi.fn<(...a: unknown[]) => Promise<string | null>>(),
  resolveKey: vi.fn<() => Promise<string | null>>(),
  readGlobalConfig: vi.fn<() => Record<string, unknown>>(),
  anthropicCreate: vi.fn<(...a: unknown[]) => Promise<{ content: Array<{ type: string; text?: string }> }>>(),
}));
vi.mock('../announcer/generate.js', () => ({ resolveAnnouncerModel: m.resolveAnnouncerModel }));
vi.mock('../announcer/models.js', () => ({ providerForModel: m.providerForModel }));
vi.mock('../announcer/appleFoundation.js', () => ({ runAppleFoundationSummarize: m.runApple }));
vi.mock('../announcer/localProvider.js', () => ({ runLocalSummarize: m.runLocal, DEFAULT_LOCAL_ENDPOINT: 'http://localhost:11434/v1' }));
vi.mock('../announcer/key.js', () => ({ resolveAnnouncerKey: m.resolveKey }));
vi.mock('../global-config.js', () => ({ readGlobalConfig: m.readGlobalConfig }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: m.anthropicCreate }; } }));

const SCHEMA = { type: 'object' };

beforeEach(() => {
  m.resolveAnnouncerModel.mockReset().mockResolvedValue('some-model');
  m.providerForModel.mockReset();
  m.runApple.mockReset().mockResolvedValue('{"apple":1}');
  m.runLocal.mockReset().mockResolvedValue('{"local":1}');
  m.resolveKey.mockReset();
  m.readGlobalConfig.mockReset().mockReturnValue({});
  m.anthropicCreate.mockReset();
});
afterEach(() => { vi.clearAllMocks(); });

describe('callAnnouncerJson', () => {
  it('routes to the Apple Foundation provider', async () => {
    m.providerForModel.mockReturnValue('apple');
    const out = await callAnnouncerJson('sys', 'mat', SCHEMA, ' as json');
    expect(out).toBe('{"apple":1}');
    expect(m.runApple).toHaveBeenCalledWith('sys', 'mat', SCHEMA);
  });

  it('routes to the local provider with the configured endpoint + model', async () => {
    m.providerForModel.mockReturnValue('local');
    m.readGlobalConfig.mockReturnValue({ announcerLocalEndpoint: 'http://host/v1', announcerLocalModel: 'llama' });
    const out = await callAnnouncerJson('sys', 'mat', SCHEMA, ' as json');
    expect(out).toBe('{"local":1}');
    expect(m.runLocal).toHaveBeenCalledWith('sys as json', 'mat', { endpoint: 'http://host/v1', model: 'llama' });
  });

  it('local provider falls back to the default endpoint when none configured', async () => {
    m.providerForModel.mockReturnValue('local');
    m.readGlobalConfig.mockReturnValue({});
    await callAnnouncerJson('sys', 'mat', SCHEMA, '');
    expect(m.runLocal).toHaveBeenCalledWith('sys', 'mat', { endpoint: 'http://localhost:11434/v1', model: '' });
  });

  it('returns null for an Anthropic model with no key (heuristic fallback)', async () => {
    m.providerForModel.mockReturnValue('anthropic');
    m.resolveKey.mockResolvedValue(null);
    expect(await callAnnouncerJson('sys', 'mat', SCHEMA, '')).toBeNull();
    expect(m.anthropicCreate).not.toHaveBeenCalled();
  });

  it('calls Anthropic and concatenates text blocks when a key is present', async () => {
    m.providerForModel.mockReturnValue('anthropic');
    m.resolveKey.mockResolvedValue('sk-test');
    m.anthropicCreate.mockResolvedValue({ content: [{ type: 'text', text: '{"a":' }, { type: 'tool_use' }, { type: 'text', text: '1}' }] });
    const out = await callAnnouncerJson('sys', 'mat', SCHEMA, '', 512);
    expect(out).toBe('{"a":1}');
    expect(m.anthropicCreate).toHaveBeenCalledWith(expect.objectContaining({ model: 'some-model', max_tokens: 512, system: 'sys' }));
  });
});
