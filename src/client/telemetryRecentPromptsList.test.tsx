// @vitest-environment happy-dom
/**
 * HS-8779 — the recent-prompts list renderer. The list used to show only
 * `<timestamp> (unknown model) <uuid-fragment>` per row, which carried no
 * signal; it now leads with a prompt summary and a meta line of derived
 * token/cost/duration/tool chips. These tests pin that rendering + the
 * "only emit chips that have data" rule.
 */
import { describe, expect, it } from 'vitest';

import { type RecentPromptRow, renderRecentPromptsList } from './telemetryRecentPromptsList.js';

function row(over: Partial<RecentPromptRow> = {}): RecentPromptRow {
  return {
    promptId: 'abc1234567890def',
    ts: '2026-05-20T10:00:00Z',
    projectSecret: 'secret-A',
    model: null,
    ...over,
  };
}

describe('renderRecentPromptsList (HS-8779)', () => {
  it('leads with the prompt-text snippet when present', () => {
    const list = renderRecentPromptsList([row({ promptText: 'Fix the login bug' })]);
    expect(list.querySelector('.telemetry-recent-prompt-summary')?.textContent).toBe('Fix the login bug');
  });

  it('falls back to a labeled short prompt id when no text is available', () => {
    const list = renderRecentPromptsList([row({ promptText: null })]);
    expect(list.querySelector('.telemetry-recent-prompt-summary')?.textContent).toBe('Prompt abc12345');
  });

  it('renders model + token + cost + duration + tool chips when present', () => {
    const list = renderRecentPromptsList([row({
      model: 'sonnet-4', totalTokens: 1800, inputTokens: 1500, outputTokens: 300,
      costUsd: 0.05, durationMs: 5000, toolCount: 2,
    })]);
    const chips = [...list.querySelectorAll('.telemetry-recent-prompt-chip')].map(c => c.textContent);
    expect(chips).toContain('sonnet-4');
    expect(chips).toContain('1.8K tokens');
    expect(chips).toContain('$0.05');
    expect(chips).toContain('5.0s');
    expect(chips).toContain('2 tools');
  });

  it('omits chips for fields with no data (null or zero)', () => {
    const list = renderRecentPromptsList([row({ model: null, totalTokens: null, costUsd: null, durationMs: null, toolCount: 0 })]);
    // Only the timestamp survives on the meta line; no metric chips.
    expect(list.querySelectorAll('.telemetry-recent-prompt-chip')).toHaveLength(0);
    expect(list.querySelector('.telemetry-recent-prompt-ts')).not.toBeNull();
  });

  it('singularizes the tool chip for a single tool call', () => {
    const list = renderRecentPromptsList([row({ toolCount: 1 })]);
    const chips = [...list.querySelectorAll('.telemetry-recent-prompt-chip')].map(c => c.textContent);
    expect(chips).toContain('1 tool');
  });

  it('keeps the prompt id on the row for the drilldown click target', () => {
    const list = renderRecentPromptsList([row({ promptId: 'pid-xyz' })]);
    expect(list.querySelector('.telemetry-recent-prompt')?.getAttribute('data-prompt-id')).toBe('pid-xyz');
  });
});
