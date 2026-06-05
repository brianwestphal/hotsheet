import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANNOUNCER_MODEL, summarizeWork } from './summarize.js';

interface CreateArgs { model: string; system?: string; output_config?: unknown }
interface FakeMessage { content: { type: string; text?: string }[] }

const ctorMock = vi.fn<(opts: { apiKey: string }) => void>();
const createMock = vi.fn<(args: CreateArgs) => Promise<FakeMessage>>();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (args: CreateArgs) => createMock(args) };
    constructor(opts: { apiKey: string }) { ctorMock(opts); }
  },
}));

function textResponse(obj: unknown): FakeMessage {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }] };
}

beforeEach(() => { ctorMock.mockReset(); createMock.mockReset(); });

describe('summarizeWork (HS-8745)', () => {
  it('passes the API key + default model + structured-output config, returns parsed entries', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [{ title: 'Fixed it', script: 'I fixed the bug.' }] }));
    const res = await summarizeWork('some real work material', { apiKey: 'sk-test' });

    expect(ctorMock).toHaveBeenCalledWith({ apiKey: 'sk-test' });
    const args = createMock.mock.calls[0][0];
    expect(args.model).toBe(ANNOUNCER_MODEL);
    expect(args.output_config).toBeDefined();
    expect(res).toEqual([{ title: 'Fixed it', script: 'I fixed the bug.' }]);
  });

  it('empty / whitespace material short-circuits without an API call', async () => {
    expect(await summarizeWork('   ', { apiKey: 'sk-test' })).toEqual([]);
    expect(createMock).not.toHaveBeenCalled();
  });

  it('malformed JSON in the response → empty (no throw)', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'not json at all' }] });
    expect(await summarizeWork('m', { apiKey: 'sk-test' })).toEqual([]);
  });

  it('schema-mismatched JSON → empty', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [{ title: 123 }] }));
    expect(await summarizeWork('m', { apiKey: 'sk-test' })).toEqual([]);
  });

  it('honors a model override (e.g. a cheaper model)', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [] }));
    await summarizeWork('m', { apiKey: 'sk-test', model: 'claude-haiku-4-5' });
    expect(createMock.mock.calls[0][0].model).toBe('claude-haiku-4-5');
  });
});
