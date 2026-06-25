// @vitest-environment happy-dom
/**
 * HS-8913 — once-per-project AI-instructions nudge: decision logic + dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setApiTransport } from '../api/_runner.js';
import type { AiInstructionsStateResp } from '../api/aiInstructions.js';
import { _resetCheckedSecretsForTesting, aiNudgeDisabledForTesting, decideNudgeAction, maybeShowAiInstructionsNudge, type NudgeAction, showAiInstructionsNudgeDialog } from './aiInstructionsNudge.js';
import { setActiveProject } from './state.js';

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

describe('maybeShowAiInstructionsNudge per-project guard (HS-8913)', () => {
  let statusCalls: number;

  beforeEach(() => {
    statusCalls = 0;
    _resetCheckedSecretsForTesting();
    setApiTransport((path) => {
      if (path === '/ai-instructions/status') {
        statusCalls += 1;
        // present + current → action 'none', so no dialog / no apply fires.
        return Promise.resolve(makeState({ present: true, setupNeeded: false }));
      }
      if (path === '/file-settings') return Promise.resolve({});
      return Promise.resolve({});
    });
  });

  afterEach(() => {
    document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());
  });

  function activate(secret: string): void {
    setActiveProject({ name: secret, dataDir: `/tmp/${secret}`, secret });
  }

  it('checks each project once, re-checks a newly-selected project, and skips a re-toggle', async () => {
    activate('project-a');
    maybeShowAiInstructionsNudge();
    await Promise.resolve();
    await Promise.resolve();
    expect(statusCalls).toBe(1);

    // Toggling back to the same project does not re-fire the status call.
    maybeShowAiInstructionsNudge();
    await Promise.resolve();
    expect(statusCalls).toBe(1);

    // A different, newly-selected project IS checked.
    activate('project-b');
    maybeShowAiInstructionsNudge();
    await Promise.resolve();
    await Promise.resolve();
    expect(statusCalls).toBe(2);

    // ...and only once.
    maybeShowAiInstructionsNudge();
    await Promise.resolve();
    expect(statusCalls).toBe(2);
  });
});

describe('maybeShowAiInstructionsNudge e2e disable gate (HS-9066)', () => {
  let statusCalls: number;
  const win = window as unknown as { __HOTSHEET_DISABLE_AI_NUDGE__?: boolean };

  beforeEach(() => {
    statusCalls = 0;
    _resetCheckedSecretsForTesting();
    setApiTransport((path) => {
      if (path === '/ai-instructions/status') { statusCalls += 1; return Promise.resolve(makeState({ present: false, detected: true })); }
      if (path === '/file-settings') return Promise.resolve({});
      return Promise.resolve({});
    });
    setActiveProject({ name: 'p', dataDir: '/tmp/p', secret: 'p' });
  });

  afterEach(() => {
    delete win.__HOTSHEET_DISABLE_AI_NUDGE__;
    document.querySelectorAll('.ai-instructions-nudge-overlay').forEach(el => el.remove());
  });

  it('returns early without fetching status or mounting the overlay when the flag is set', async () => {
    win.__HOTSHEET_DISABLE_AI_NUDGE__ = true;
    expect(aiNudgeDisabledForTesting()).toBe(true);
    maybeShowAiInstructionsNudge();
    await Promise.resolve();
    await Promise.resolve();
    expect(statusCalls).toBe(0);
    expect(document.querySelector('.ai-instructions-nudge-overlay')).toBeNull();
  });

  it('runs the status check normally when the flag is absent', async () => {
    expect(aiNudgeDisabledForTesting()).toBe(false);
    maybeShowAiInstructionsNudge();
    await Promise.resolve();
    await Promise.resolve();
    expect(statusCalls).toBe(1);
  });
});
