// @vitest-environment happy-dom
/**
 * HS-9367 (docs/119) — selected-tool prep nudge: decision logic + dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setApiTransport } from '../api/_runner.js';
import type { ToolPrepStatusResp } from '../api/aiInstructions.js';
import { _resetToolPrepCheckedForTesting, decideToolPrepAction, maybeOfferToolPrep, showToolPrepDialog, type ToolPrepAction } from './toolPrepNudge.js';

function status(partial: Partial<ToolPrepStatusResp>): ToolPrepStatusResp {
  return {
    aiTool: 'codex',
    instructionTool: 'codex',
    instructionsNeeded: true,
    instructionsPath: 'AGENTS.md',
    skillsNeeded: true,
    skillsPath: '.agents/skills/hotsheet/SKILL.md',
    needed: true,
    ...partial,
  };
}

describe('decideToolPrepAction', () => {
  const cases: Array<[string, Pick<ToolPrepStatusResp, 'aiTool' | 'needed'>, 'switch' | 'open', string | null, ToolPrepAction]> = [
    ['auto + switch → silent ensure (pre-HS-9367 refresh preserved)', { aiTool: 'auto', needed: false }, 'switch', null, 'silent-ensure'],
    ['auto + open → none', { aiTool: 'auto', needed: false }, 'open', null, 'none'],
    ['prepared tool + switch → silent ensure', { aiTool: 'codex', needed: false }, 'switch', null, 'silent-ensure'],
    ['prepared tool + open → none', { aiTool: 'codex', needed: false }, 'open', null, 'none'],
    ['needed + switch → dialog (dismissal does NOT gate an explicit switch)', { aiTool: 'codex', needed: true }, 'switch', 'codex', 'dialog'],
    ['needed + open + not dismissed → dialog', { aiTool: 'codex', needed: true }, 'open', null, 'dialog'],
    ['needed + open + dismissed for THIS tool → none', { aiTool: 'codex', needed: true }, 'open', 'codex', 'none'],
    ['needed + open + dismissed for a DIFFERENT tool → dialog (re-armed)', { aiTool: 'codex', needed: true }, 'open', 'opencode', 'dialog'],
  ];
  for (const [name, st, source, dismissed, expected] of cases) {
    it(name, () => {
      expect(decideToolPrepAction(st, source, dismissed)).toBe(expected);
    });
  }
});

describe('showToolPrepDialog + maybeOfferToolPrep', () => {
  const calls: Array<{ path: string; method?: string }> = [];
  let responses: Record<string, unknown>;

  beforeEach(() => {
    document.body.innerHTML = '';
    calls.length = 0;
    _resetToolPrepCheckedForTesting();
    responses = {};
    setApiTransport((path, opts) => {
      calls.push({ path, method: opts.method });
      const r = responses[path];
      if (r === undefined) throw new Error(`unexpected call: ${path}`);
      return Promise.resolve(r);
    });
  });
  afterEach(() => {
    document.querySelectorAll('.tool-prep-nudge-overlay').forEach(el => el.remove());
    vi.useRealTimers();
  });

  it('renders the tool label + only the files that need writing', () => {
    showToolPrepDialog(status({ skillsNeeded: false, skillsPath: '.agents/skills/hotsheet/SKILL.md' }));
    const overlay = document.querySelector('.tool-prep-nudge-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain('Prepare Codex Config?');
    expect(overlay?.textContent).toContain('AGENTS.md');
    expect(overlay?.querySelectorAll('li')).toHaveLength(1); // skills item omitted
  });

  it('the CTA posts /ai-instructions/prepare-tool', () => {
    responses['/ai-instructions/prepare-tool'] = { instructionsWritten: true, platforms: ['Codex'], status: status({ needed: false }) };
    showToolPrepDialog(status({}));
    document.querySelector<HTMLButtonElement>('.ai-instructions-nudge-cta')?.click();
    expect(calls).toContainEqual({ path: '/ai-instructions/prepare-tool', method: 'POST' });
  });

  it('"Not now" persists the dismissed tool to file settings', () => {
    responses['/file-settings'] = {};
    showToolPrepDialog(status({}));
    document.querySelector<HTMLAnchorElement>('.ai-instructions-nudge-dismiss')?.click();
    expect(document.querySelector('.tool-prep-nudge-overlay')).toBeNull();
    const write = calls.find(c => c.method !== undefined && c.path === '/file-settings');
    expect(write).toBeDefined();
  });

  it('maybeOfferToolPrep(open): dialog when needed; checked once per session', async () => {
    responses['/ai-instructions/tool-prep'] = status({});
    responses['/file-settings'] = {};
    maybeOfferToolPrep('open');
    await vi.waitFor(() => { expect(document.querySelector('.tool-prep-nudge-overlay')).not.toBeNull(); });
  });

  it('honors the __HOTSHEET_DISABLE_AI_NUDGE__ e2e seam — no dialog, switch still ensures skills', async () => {
    (window as unknown as { __HOTSHEET_DISABLE_AI_NUDGE__?: boolean }).__HOTSHEET_DISABLE_AI_NUDGE__ = true;
    try {
      responses['/ensure-skills'] = { updated: false };
      maybeOfferToolPrep('switch');
      await vi.waitFor(() => {
        expect(calls.some(c => c.path === '/ensure-skills' && c.method === 'POST')).toBe(true);
      });
      // No status fetch, no dialog.
      expect(calls.some(c => c.path === '/ai-instructions/tool-prep')).toBe(false);
      expect(document.querySelector('.tool-prep-nudge-overlay')).toBeNull();

      calls.length = 0;
      maybeOfferToolPrep('open'); // fully inert on the open path
      await new Promise(r => setTimeout(r, 0));
      expect(calls).toEqual([]);
    } finally {
      delete (window as unknown as { __HOTSHEET_DISABLE_AI_NUDGE__?: boolean }).__HOTSHEET_DISABLE_AI_NUDGE__;
    }
  });

  it('maybeOfferToolPrep(switch): silently ensures skills when nothing is needed', async () => {
    responses['/ai-instructions/tool-prep'] = status({ needed: false });
    responses['/file-settings'] = {};
    responses['/ensure-skills'] = { updated: false };
    maybeOfferToolPrep('switch');
    await vi.waitFor(() => {
      expect(calls.some(c => c.path === '/ensure-skills' && c.method === 'POST')).toBe(true);
    });
    expect(document.querySelector('.tool-prep-nudge-overlay')).toBeNull();
  });
});
