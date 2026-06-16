import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ANNOUNCER_MODEL, buildSystemPrompt, dropToolChurn, isToolChurn, summarizeWork } from './summarize.js';

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

// HS-8790 — the Apple (on-device) provider is a subprocess; mock it so the
// routing in `summarizeWork` is testable without the native helper.
const appleRunMock = vi.fn<(system: string, material: string) => Promise<string>>();
vi.mock('./appleFoundation.js', () => ({
  runAppleFoundationSummarize: (system: string, material: string) => appleRunMock(system, material),
}));

// HS-8792 — the local (OpenAI-compatible) provider is an HTTP call; mock it so
// the provider routing is testable without a running endpoint.
const localRunMock = vi.fn<(system: string, material: string, opts: { endpoint: string; model: string }) => Promise<string>>();
vi.mock('./localProvider.js', () => ({
  DEFAULT_LOCAL_ENDPOINT: 'http://localhost:11434/v1',
  runLocalSummarize: (system: string, material: string, opts: { endpoint: string; model: string }) => localRunMock(system, material, opts),
}));

// HS-8766 — fake responses carry a `usage` block (the SDK always does).
function textResponse(obj: unknown, usage = { input_tokens: 100, output_tokens: 40 }): FakeMessage {
  return { content: [{ type: 'text', text: JSON.stringify(obj) }], usage };
}

beforeEach(() => { ctorMock.mockReset(); createMock.mockReset(); appleRunMock.mockReset(); localRunMock.mockReset(); });

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

  // HS-8790 — provider routing.
  it('routes an Apple model to the on-device helper (no Anthropic call, no key, no usage)', async () => {
    appleRunMock.mockResolvedValue(JSON.stringify({ entries: [{ title: 'Local', script: 'Summarized on device.' }] }));
    const res = await summarizeWork('real material', { model: 'apple-foundation' });

    expect(appleRunMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();   // no cloud call
    expect(ctorMock).not.toHaveBeenCalled();      // no Anthropic client built
    expect(res.entries).toEqual([{ title: 'Local', script: 'Summarized on device.' }]);
    expect(res.usage).toBeNull();                 // on-device = free
  });

  it('throws for an Anthropic model when no key is supplied', async () => {
    await expect(summarizeWork('real material', { model: 'claude-haiku-4-5' })).rejects.toThrow(/API key/);
    expect(createMock).not.toHaveBeenCalled();
  });

  // HS-8792 — local-provider routing.
  it('routes a local model to the OpenAI-compatible endpoint (no Anthropic call, no key, no usage)', async () => {
    localRunMock.mockResolvedValue(JSON.stringify({ entries: [{ title: 'On device', script: 'Summarized locally.' }] }));
    const res = await summarizeWork('real material', { model: 'local', localEndpoint: 'http://localhost:1234/v1', localModel: 'llama3.1' });

    expect(localRunMock).toHaveBeenCalledTimes(1);
    expect(createMock).not.toHaveBeenCalled();   // no cloud call
    expect(ctorMock).not.toHaveBeenCalled();      // no Anthropic client built
    // The local path passes through the resolved endpoint + model and appends the
    // JSON-format instruction to the system prompt.
    const [system, , opts] = localRunMock.mock.calls[0];
    expect(opts).toEqual({ endpoint: 'http://localhost:1234/v1', model: 'llama3.1' });
    expect(system).toContain('OUTPUT FORMAT');
    expect(res.entries).toEqual([{ title: 'On device', script: 'Summarized locally.' }]);
    expect(res.usage).toBeNull();                 // on-device = free
  });

  it('falls back to the default local endpoint when none is configured', async () => {
    localRunMock.mockResolvedValue('{"entries":[]}');
    await summarizeWork('real material', { model: 'local', localModel: 'llama3.1' });
    expect(localRunMock.mock.calls[0][2]).toEqual({ endpoint: 'http://localhost:11434/v1', model: 'llama3.1' });
  });

  // HS-8789 — the model rates importance; `low` entries are dropped before persist.
  it('drops entries the model rated low importance, keeps medium/high/unrated', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [
      { title: 'Shipped', script: 'Shipped the export feature.', importance: 'high' },
      { title: 'Noise', script: 'Read a file.', importance: 'low' },
      { title: 'Legacy', script: 'A note with no importance field.' },
    ] }));
    const res = await summarizeWork('m', { apiKey: 'sk-test' });
    expect(res.entries.map(e => e.title)).toEqual(['Shipped', 'Legacy']);
    // usage still captured regardless of filtering.
    expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
  });

  // HS-8800 — the after-the-fact "Listen" digest passes excludeLowImportance:false
  // so a minor `low`-rated completion note isn't silently dropped to an empty reel.
  it('keeps low-importance entries when excludeLowImportance is false (after-the-fact digest)', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [
      { title: 'Shipped', script: 'Shipped the export feature.', importance: 'high' },
      { title: 'Minor', script: 'Tweaked a tooltip copy string.', importance: 'low' },
    ] }));
    const res = await summarizeWork('m', { apiKey: 'sk-test', excludeLowImportance: false });
    expect(res.entries.map(e => e.title)).toEqual(['Shipped', 'Minor']);
  });

  it('still drops pure tool churn even when excludeLowImportance is false (HS-8806 net stays on)', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [
      { title: 'Real', script: 'Fixed the cross-project tag leak.', importance: 'low' },
      { title: 'Churn', script: 'Read Bash Edit', importance: 'low' },
    ] }));
    const res = await summarizeWork('m', { apiKey: 'sk-test', excludeLowImportance: false });
    // The low-but-substantive entry is kept; the pure tool-churn entry is dropped.
    expect(res.entries.map(e => e.title)).toEqual(['Real']);
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

  // HS-8749 — tier-1 emphasis: the model may return an `emphasis` array, which
  // is parsed through and preserved on the entry.
  it('parses the optional emphasis array (HS-8749)', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [{ title: 'Fixed it', script: 'fixed the export bug', emphasis: ['export bug'] }] }));
    const res = await summarizeWork('m', { apiKey: 'sk-test' });
    expect(res.entries[0].emphasis).toEqual(['export bug']);
  });

  it('instructs the model about the emphasis field (HS-8749)', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [] }));
    await summarizeWork('m', { apiKey: 'sk-test' });
    expect((createMock.mock.calls[0][0].system ?? '').toLowerCase()).toContain('emphasis');
  });

  // HS-8768 — backlog compression directive.
  it('buildSystemPrompt adds the catch-up directive only at high compression', () => {
    expect(buildSystemPrompt({})).not.toContain('BACKLOG');
    expect(buildSystemPrompt({ compression: 'normal' })).not.toContain('BACKLOG');
    expect(buildSystemPrompt({ compression: 'high' })).toContain('BACKLOG');
  });

  // HS-8820 — completions + feedback-waiting tickets should almost always be
  // narrated with a concise note summary, not merged away or dropped.
  it('buildSystemPrompt instructs near-always narration of completions + feedback requests', () => {
    const p = buildSystemPrompt({});
    expect(p).toContain('WAITING FOR FEEDBACK');
    expect(p).toMatch(/completions/i);
    // The priority rule forbids dropping/merging these and rates them above low.
    expect(p).toContain('marked completed.');
    expect(p).toMatch(/never.*"low"/i);
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

  // HS-8806 — tool-churn guard: entries that are just tool names / raw activity
  // ("Read Bash Edit") carry no value and must never reach the reel.
  describe('tool-churn guard (HS-8806)', () => {
    it('isToolChurn flags pure tool-name / ongoing-work text', () => {
      expect(isToolChurn('Read Bash Edit')).toBe(true);
      expect(isToolChurn('used Read, Bash and Edit')).toBe(true);
      expect(isToolChurn('used Bash ×3, Edit ×2')).toBe(true);
      expect(isToolChurn('ongoing work')).toBe(true);
      expect(isToolChurn('ran some commands')).toBe(true);
    });

    it('isToolChurn keeps any text with a substantive word', () => {
      expect(isToolChurn('Fixed the export bug')).toBe(false);
      expect(isToolChurn('Edited the parser and added tests')).toBe(false);
      expect(isToolChurn('Read the requirements doc')).toBe(false); // "requirements"/"doc" are substantive
      expect(isToolChurn('Shipped CSV export')).toBe(false);
      expect(isToolChurn('')).toBe(false); // empty isn't "churn"
    });

    it('dropToolChurn removes entries whose script is pure churn, keeps real ones', () => {
      const kept = dropToolChurn([
        { title: 'Activity', script: 'Read Bash Edit' },
        { title: 'Shipped export', script: 'Finished the CSV export and its tests.' },
        { title: 'Ongoing', script: 'used Read, Bash and Edit' },
      ]);
      expect(kept.map(e => e.title)).toEqual(['Shipped export']);
    });

    it('summarizeWork drops a tool-churn entry the model failed to rate low (end to end)', async () => {
      createMock.mockResolvedValue(textResponse({ entries: [
        { title: 'Did stuff', script: 'Read Bash Edit' },           // churn, unrated
        { title: 'Shipped', script: 'Finished the export feature.' }, // real
      ] }));
      const res = await summarizeWork('m', { apiKey: 'sk-test' });
      expect(res.entries.map(e => e.title)).toEqual(['Shipped']);
    });
  });

  // HS-8806 — guard the prompt directives that tell the model to omit ongoing
  // work + never emit tool-name lists, so a future prompt edit can't regress them.
  it('instructs the model to omit ongoing work and forbid tool-name lists (HS-8806)', async () => {
    createMock.mockResolvedValue(textResponse({ entries: [] }));
    await summarizeWork('m', { apiKey: 'sk-test' });
    const system = (createMock.mock.calls[0][0].system ?? '').toLowerCase();
    expect(system).toContain('cohesive');
    expect(system).toMatch(/list of tool names|tool names/);
    expect(system).toContain('underway');
  });

  // HS-8805 — the on-device Apple FM helper can fail inference (exit code 4)
  // even though `--probe` reported available. With an Anthropic fallback key
  // configured (auto-selected model), a failure transparently falls over to
  // Anthropic instead of breaking the whole batch.
  describe('on-device → Anthropic fallback (HS-8805)', () => {
    it('falls back to Anthropic (default model) when the Apple helper throws and a fallback key is set', async () => {
      appleRunMock.mockRejectedValue(new Error('Apple Foundation Models helper exited with code 4'));
      createMock.mockResolvedValue(textResponse({ entries: [{ title: 'Recovered', script: 'Summarized via fallback.' }] }));

      const res = await summarizeWork('real material', { model: 'apple-foundation', anthropicFallbackKey: 'sk-fallback' });

      expect(appleRunMock).toHaveBeenCalledTimes(1);
      expect(ctorMock).toHaveBeenCalledWith({ apiKey: 'sk-fallback' });
      // Cost must attribute to the model that actually ran (the Anthropic
      // default), NOT the apple id (which prices at $0).
      expect(createMock.mock.calls[0][0].model).toBe(ANNOUNCER_MODEL);
      expect(res.modelUsed).toBe(ANNOUNCER_MODEL);
      expect(res.entries).toEqual([{ title: 'Recovered', script: 'Summarized via fallback.' }]);
      expect(res.usage).toEqual({ inputTokens: 100, outputTokens: 40 });
    });

    it('re-throws the original Apple error when no fallback key is configured (no silent cloud call)', async () => {
      appleRunMock.mockRejectedValue(new Error('Apple Foundation Models helper exited with code 4'));
      await expect(summarizeWork('real material', { model: 'apple-foundation' })).rejects.toThrow(/code 4/);
      expect(createMock).not.toHaveBeenCalled();
      expect(ctorMock).not.toHaveBeenCalled();
    });

    it('does NOT fall back when the on-device call succeeds (no cloud call)', async () => {
      appleRunMock.mockResolvedValue(JSON.stringify({ entries: [{ title: 'On device', script: 'All good.' }] }));
      const res = await summarizeWork('real material', { model: 'apple-foundation', anthropicFallbackKey: 'sk-fallback' });
      expect(createMock).not.toHaveBeenCalled();
      expect(res.usage).toBeNull();
      expect(res.modelUsed).toBeUndefined();
    });

    it('also falls back when the local provider throws and a fallback key is set', async () => {
      localRunMock.mockRejectedValue(new Error('local endpoint refused connection'));
      createMock.mockResolvedValue(textResponse({ entries: [{ title: 'Recovered', script: 'Via fallback.' }] }));
      const res = await summarizeWork('real material', { model: 'local', localModel: 'llama3.1', anthropicFallbackKey: 'sk-fallback' });
      expect(createMock).toHaveBeenCalledTimes(1);
      expect(res.modelUsed).toBe(ANNOUNCER_MODEL);
      expect(res.entries).toEqual([{ title: 'Recovered', script: 'Via fallback.' }]);
    });
  });
});
