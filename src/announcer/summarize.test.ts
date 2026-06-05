import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANNOUNCER_MODEL, buildSystemPrompt, summarizeWork } from './summarize.js';

interface CreateArgs { model: string; system?: string; output_config?: unknown }
interface FakeMessage { content: { type: string; text?: string }[]; usage: { input_tokens: number; output_tokens: number } }

const ctorMock = vi.fn<(opts: { apiKey: string }) => void>();
const createMock = vi.fn<(args: CreateArgs) => Promise<FakeMessage>>();

vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: (args: CreateArgs) => createMock(args) };
    constructor(opts: { apiKey: string }) { ctorMock(opts); }
  },
}));

// HS-8766 — fake responses carry a `usage` block (the SDK always does).
function textResponse(obj: unknown, usage = { input_tokens: 100, output_tokens: 40 }): FakeMessage {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], usage };
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
    expect(res.entries).toEqual([{ title: 'Fixed it', script: 'I fixed the bug.' }]);
    // HS-8766 — usage is returned for cost accounting.
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
  });

  it('empty / whitespace material short-circuits without an API call', async () => {
    expect(await summarizeWork('   ', { apiKey: 'sk-test' })).toEqual({ entries: [], usage: null });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('malformed JSON → empty entries but usage still captured (HS-8766)', async () => {
    createMock.mockResolvedValue({ content: [{ type: 'text', text: 'not json at all' }], usage: { input_tokens: 7, output_tokens: 3 } });
    const res = await summarizeWork('m', { apiKey: 'sk-test' });
    expect(res.entries).toEqual([]);
    expect(res.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
  });

  it('schema-mismatched JSON → empty entries', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [{ title: 123 }] }));
    expect((await summarizeWork('m', { apiKey: 'sk-test' })).entries).toEqual([]);
  });

  // HS-8755 — the narration should be concise; guard the brevity directive so a
  // future prompt edit doesn't silently regress to verbose scripts.
  it('instructs the model to keep scripts short (HS-8755)', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [] }));
    await summarizeWork('m', { apiKey: 'sk-test' });
    const system = createMock.mock.calls[0][0].system ?? '';
    expect(system.toLowerCase()).toContain('under 30 words');
    expect(system.toLowerCase()).toMatch(/one or at most two short sentences|terse/);
  });

  it('defaults to the cheapest model (HS-8764)', () => {
    expect(ANNOUNCER_MODEL).toBe('claude-haiku-4-5');
  });

  // HS-8768 — backlog compression directive.
  it('buildSystemPrompt adds the catch-up directive only at high compression', () => {
    expect(buildSystemPrompt({})).not.toContain('BACKLOG');
    expect(buildSystemPrompt({ compression: 'normal' })).not.toContain('BACKLOG');
    expect(buildSystemPrompt({ compression: 'high' })).toContain('BACKLOG');
  });

  // HS-8769 — learn-from-skips: inject the omit-list.
  it('buildSystemPrompt injects the dismissed topics (omitting blanks)', () => {
    const p = buildSystemPrompt({ dismissedTopics: ['lint runs', '   ', 'test output'] });
    expect(p).toContain('uninteresting');
    expect(p).toContain('"lint runs"');
    expect(p).toContain('"test output"');
    expect(buildSystemPrompt({ dismissedTopics: [] })).not.toContain('uninteresting');
    expect(buildSystemPrompt({ dismissedTopics: ['  '] })).not.toContain('uninteresting');
  });

  it('honors a model override (e.g. a more capable model)', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [] }));
    await summarizeWork('m', { apiKey: 'sk-test', model: 'claude-sonnet-4-6' });
    expect(createMock.mock.calls[0][0].model).toBe('claude-sonnet-4-6');
  });
});
