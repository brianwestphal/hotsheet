// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';

import {
  _resetCommandTooltipForTesting,
  hideCommandTooltip,
  lastRunLine,
  showCommandTooltip,
} from './commandTooltip.js';

describe('commandTooltip (HS-8847)', () => {
  afterEach(() => {
    _resetCommandTooltipForTesting();
    document.body.innerHTML = '';
  });

  describe('lastRunLine', () => {
    it('reads "Not run yet" when there is no last-run timestamp', () => {
      expect(lastRunLine(null)).toBe('Not run yet');
    });

    it('prefixes the relative time with "Last run: " when a timestamp exists', () => {
      const line = lastRunLine(new Date().toISOString());
      expect(line.startsWith('Last run: ')).toBe(true);
    });
  });

  describe('showCommandTooltip / hideCommandTooltip', () => {
    function anchor(): HTMLElement {
      const btn = document.createElement('button');
      document.body.appendChild(btn);
      return btn;
    }

    it('renders the name, command, and last-run line, and reuses one singleton element', () => {
      showCommandTooltip(anchor(), { name: 'Build', command: 'npm run build', lastRunIso: null });
      let tips = document.querySelectorAll('.command-tooltip');
      expect(tips.length).toBe(1);
      const tip = tips[0];
      expect(tip.querySelector('.command-tooltip-name')?.textContent).toBe('Build');
      expect(tip.querySelector('.command-tooltip-cmd')?.textContent).toBe('npm run build');
      expect(tip.querySelector('.command-tooltip-lastrun')?.textContent).toBe('Not run yet');
      expect((tip as HTMLElement).hidden).toBe(false);

      // A second show reuses the same element (no pile-up) and updates content.
      showCommandTooltip(anchor(), { name: 'Test', command: 'npm test', lastRunIso: '2026-06-17T10:00:00.000Z' });
      tips = document.querySelectorAll('.command-tooltip');
      expect(tips.length).toBe(1);
      expect(tips[0].querySelector('.command-tooltip-name')?.textContent).toBe('Test');
      expect(tips[0].querySelector('.command-tooltip-lastrun')?.textContent ?? '').toContain('Last run: ');
    });

    it('omits the command line when the command text is blank', () => {
      showCommandTooltip(anchor(), { name: 'Empty', command: '   ', lastRunIso: null });
      const tip = document.querySelector('.command-tooltip');
      expect(tip?.querySelector('.command-tooltip-cmd')).toBeNull();
    });

    it('hides the tooltip on hideCommandTooltip', () => {
      showCommandTooltip(anchor(), { name: 'X', command: 'x', lastRunIso: null });
      expect((document.querySelector('.command-tooltip') as HTMLElement).hidden).toBe(false);
      hideCommandTooltip();
      expect((document.querySelector('.command-tooltip') as HTMLElement).hidden).toBe(true);
    });
  });
});
