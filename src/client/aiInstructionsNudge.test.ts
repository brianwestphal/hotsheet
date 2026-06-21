// @vitest-environment happy-dom
/**
 * HS-8913 — once-per-project AI-instructions nudge: decision logic + dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setApiTransport } from '../api/_runner.js';
import type { AiInstructionsStateResp } from '../api/aiInstructions.js';
import { decideNudgeAction, type NudgeAction, showAiInstructionsNudgeDialog } from './aiInstructionsNudge.js';

function makeState(partial: Partial<AiInstructionsStateResp> & { present?: boolean }): AiInstructionsStateResp {
  const present = partial.present ?? false;
  return {
    detected: partial.detected ?? false,
    fileExists: partial.fileExists ?? false,
    missing: partial.missing ?? !present,
    outdated: partial.outdated ?? false,
    setupNeeded: partial.setupNeeded ?? false,
    sections: partial.sections ?? [
      { id: 'ticket-driven-work', present, version: present ? 1 : null, outdated: false, needsSetup: false },
    ],
  };
}

describe('decideNudgeAction', () => {
  const cases: Array<[string, AiInstructionsStateResp, boolean, NudgeAction]> = [
    ['installed + outdated → silent update', makeState({ present: true, setupNeeded: true, outdated: true }), false, 'silent-update'],
    ['installed + current → none', makeState({ present: true, setupNeeded: false }), false, 'none'],
    ['none present + detected + not dismissed → prompt', makeState({ present: false, detected: true }), false, 'prompt'],
    ['none present + detected + dismissed → none', makeState({ present: false, detected: true }), true, 'none'],
    ['none present + not detected → none', makeState({ present: false, detected: false }), false, 'none'],
  ];
  for (const [name, state, dismissed, expected] of cases) {
    it(name, () => {
      expect(decideNudgeAction(state, dismissed)).toBe(expected);
    });
  }
});

describe('showAiInstructionsNudgeDialog', () => {
  let calls: Array<{ path: string; opts: { method?: string; body?: unknown } }>;

  beforeEach(() => {
    calls = [];
    setApiTransport((path, opts) => {
      calls.push({ path, opts });
      if (path === '/ai-instructions/apply') {
        return Promise.resolve({ written: true, state: makeState({ present: true, setupNeeded: false }) });
      }
      return Promise.resolve({}); // /file-settings PATCH
    });
  });

  afterEach(() => {
    document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());
  });

  it('renders the overlay with a title and CTA', () => {
    showAiInstructionsNudgeDialog();
    const overlay = document.querySelector('.ai-instructions-nudge-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay!.querySelector('.ai-instructions-nudge-title')!.textContent).toContain('AI Assistant');
    expect(overlay!.querySelector('.ai-instructions-nudge-cta')!.textContent).toContain('Add to CLAUDE.md');
  });

  it('"Not now" removes the overlay and persists the dismissed flag', () => {
    showAiInstructionsNudgeDialog();
    document.querySelector<HTMLAnchorElement>('.ai-instructions-nudge-dismiss')!.click();
    expect(document.querySelector('.ai-instructions-nudge-overlay')).toBeNull();
    const patch = calls.find(c => c.path === '/file-settings');
    expect(patch).toBeDefined();
    expect(patch!.opts.method).toBe('PATCH');
    expect(patch!.opts.body).toMatchObject({ ai_instructions_nudge_dismissed: true });
  });

  it('the CTA applies the instructions then dismisses', async () => {
    vi.useFakeTimers();
    try {
      showAiInstructionsNudgeDialog();
      document.querySelector<HTMLButtonElement>('.ai-instructions-nudge-cta')!.click();
      // Let the apply promise resolve, then run the close timer.
      await vi.runAllTimersAsync();
      expect(calls.some(c => c.path === '/ai-instructions/apply' && c.opts.method === 'POST')).toBe(true);
      expect(document.querySelector('.ai-instructions-nudge-overlay')).toBeNull();
      // Closing also persists the dismissed flag.
      expect(calls.some(c => c.path === '/file-settings')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('only one overlay exists even if shown twice', () => {
    showAiInstructionsNudgeDialog();
    showAiInstructionsNudgeDialog();
    expect(document.querySelectorAll('.ai-instructions-nudge-overlay').length).toBe(1);
  });
});
