import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPerProjectSessionState,
  getCategoryColor,
  getCategoryLabel,
  getPriorityColor,
  getPriorityIcon,
  getProjectGridActive,
  getProjectGridSliderValue,
  getStatusIcon,
  setActiveProject,
  setProjectGridActive,
  setProjectGridSliderValue,
  shouldResetStatusOnUpNext,
  state,
} from './state.js';

describe('getCategoryColor', () => {
  it('returns correct colors for all categories', () => {
    expect(getCategoryColor('issue')).toBe('#6b7280');
    expect(getCategoryColor('bug')).toBe('#ef4444');
    expect(getCategoryColor('feature')).toBe('#22c55e');
    expect(getCategoryColor('requirement_change')).toBe('#f97316');
    expect(getCategoryColor('task')).toBe('#3b82f6');
    expect(getCategoryColor('investigation')).toBe('#8b5cf6');
  });

  it('returns default for unknown category', () => {
    expect(getCategoryColor('unknown')).toBe('#6b7280');
  });
});

describe('getCategoryLabel', () => {
  it('returns correct abbreviations for all categories', () => {
    expect(getCategoryLabel('issue')).toBe('ISS');
    expect(getCategoryLabel('bug')).toBe('BUG');
    expect(getCategoryLabel('feature')).toBe('FEA');
    expect(getCategoryLabel('requirement_change')).toBe('REQ');
    expect(getCategoryLabel('task')).toBe('TSK');
    expect(getCategoryLabel('investigation')).toBe('INV');
  });

  it('returns default for unknown category', () => {
    expect(getCategoryLabel('unknown')).toBe('UNK');
  });
});

describe('getPriorityIcon', () => {
  it('returns correct icons for all priorities', () => {
    // All priority icons are now Lucide SVG strings
    expect(getPriorityIcon('highest')).toContain('<svg');
    expect(getPriorityIcon('high')).toContain('<svg');
    expect(getPriorityIcon('default')).toContain('<svg');
    expect(getPriorityIcon('low')).toContain('<svg');
    expect(getPriorityIcon('lowest')).toContain('<svg');
  });

  it('returns default for unknown priority', () => {
    expect(getPriorityIcon('unknown')).toBe('—');
  });
});

describe('getPriorityColor', () => {
  it('returns correct colors for all priorities', () => {
    expect(getPriorityColor('highest')).toBe('#ef4444');
    expect(getPriorityColor('high')).toBe('#f97316');
    expect(getPriorityColor('default')).toBe('#6b7280');
    expect(getPriorityColor('low')).toBe('#3b82f6');
    expect(getPriorityColor('lowest')).toBe('#94a3b8');
  });

  it('returns default for unknown priority', () => {
    expect(getPriorityColor('unknown')).toBe('#6b7280');
  });
});

describe('getStatusIcon', () => {
  it('returns correct icons for all statuses', () => {
    expect(getStatusIcon('not_started')).toBe('○');
    expect(getStatusIcon('started')).toBe('◔');
    expect(getStatusIcon('completed')).toBe('✓');
    expect(getStatusIcon('verified')).toContain('<svg');
    expect(getStatusIcon('backlog')).toBe('□');
    expect(getStatusIcon('archive')).toBe('■');
  });

  it('returns default for unknown status', () => {
    expect(getStatusIcon('unknown')).toBe('○');
  });
});

describe('shouldResetStatusOnUpNext (HS-7998)', () => {
  it('returns true for completed (existing behaviour preserved)', () => {
    expect(shouldResetStatusOnUpNext('completed')).toBe(true);
  });

  it('returns true for verified (existing behaviour preserved)', () => {
    expect(shouldResetStatusOnUpNext('verified')).toBe(true);
  });

  it('returns true for backlog — the HS-7998 fix', () => {
    expect(shouldResetStatusOnUpNext('backlog')).toBe(true);
  });

  it('returns true for archive — the HS-7998 fix', () => {
    expect(shouldResetStatusOnUpNext('archive')).toBe(true);
  });

  it('returns false for not_started (already in active workflow)', () => {
    expect(shouldResetStatusOnUpNext('not_started')).toBe(false);
  });

  it('returns false for started (already in active workflow)', () => {
    expect(shouldResetStatusOnUpNext('started')).toBe(false);
  });

  it('returns false for an unknown status (defensive — treat as already in workflow)', () => {
    expect(shouldResetStatusOnUpNext('weird-future-status')).toBe(false);
  });
});

describe('setActiveProject per-project search state (HS-7360)', () => {
  const projA = { name: 'A', dataDir: '/a', secret: 'secret-a' };
  const projB = { name: 'B', dataDir: '/b', secret: 'secret-b' };

  beforeEach(() => {
    clearPerProjectSessionState('secret-a');
    clearPerProjectSessionState('secret-b');
    state.search = '';
    state.view = 'all';
    setActiveProject(projA);
  });

  it("saves project A's search on switch and restores it on switch-back", () => {
    state.search = 'foo';
    setActiveProject(projB);
    expect(state.search).toBe('');
    setActiveProject(projA);
    expect(state.search).toBe('foo');
  });

  it('starts a never-seen project with an empty search query', () => {
    state.search = 'hello';
    setActiveProject(projB);
    expect(state.search).toBe('');
  });

  it('remembers per-project search independently', () => {
    state.search = 'aaa';
    setActiveProject(projB);
    state.search = 'bbb';
    setActiveProject(projA);
    expect(state.search).toBe('aaa');
    setActiveProject(projB);
    expect(state.search).toBe('bbb');
  });

  it('clearPerProjectSessionState wipes both view and search for a secret', () => {
    state.search = 'zzz';
    state.view = 'up-next';
    setActiveProject(projB);
    clearPerProjectSessionState('secret-a');
    setActiveProject(projA);
    expect(state.search).toBe('');
    expect(state.view).toBe('all');
  });

  it('switch-to-same-secret preserves the current query under that secret', () => {
    state.search = 'keep';
    setActiveProject(projA);
    setActiveProject(projB);
    setActiveProject(projA);
    expect(state.search).toBe('keep');
  });
});

describe('per-project drawer grid state (HS-6311)', () => {
  const projA = { name: 'A', dataDir: '/a', secret: 'grid-a' };
  const projB = { name: 'B', dataDir: '/b', secret: 'grid-b' };

  beforeEach(() => {
    clearPerProjectSessionState('grid-a');
    clearPerProjectSessionState('grid-b');
    setActiveProject(projA);
  });

  it('defaults grid-active to false for a never-seen project', () => {
    expect(getProjectGridActive('grid-a')).toBe(false);
    expect(getProjectGridActive('grid-b')).toBe(false);
  });

  it('setProjectGridActive(true) persists for that secret', () => {
    setProjectGridActive('grid-a', true);
    expect(getProjectGridActive('grid-a')).toBe(true);
    expect(getProjectGridActive('grid-b')).toBe(false);
  });

  it('setProjectGridActive(false) clears the flag (distinct from never-seen)', () => {
    setProjectGridActive('grid-a', true);
    setProjectGridActive('grid-a', false);
    expect(getProjectGridActive('grid-a')).toBe(false);
  });

  it('defaults slider value to 33 for a never-seen project', () => {
    expect(getProjectGridSliderValue('grid-a')).toBe(33);
    expect(getProjectGridSliderValue('grid-b')).toBe(33);
  });

  it('setProjectGridSliderValue persists per secret', () => {
    setProjectGridSliderValue('grid-a', 60);
    setProjectGridSliderValue('grid-b', 15);
    expect(getProjectGridSliderValue('grid-a')).toBe(60);
    expect(getProjectGridSliderValue('grid-b')).toBe(15);
  });

  it('grid state survives a setActiveProject round-trip — not cleared by project switch', () => {
    setProjectGridActive('grid-a', true);
    setProjectGridSliderValue('grid-a', 72);
    setActiveProject(projB);
    setActiveProject(projA);
    expect(getProjectGridActive('grid-a')).toBe(true);
    expect(getProjectGridSliderValue('grid-a')).toBe(72);
  });

  it('clearPerProjectSessionState drops grid-active + slider value for that secret', () => {
    setProjectGridActive('grid-a', true);
    setProjectGridSliderValue('grid-a', 50);
    clearPerProjectSessionState('grid-a');
    expect(getProjectGridActive('grid-a')).toBe(false);
    expect(getProjectGridSliderValue('grid-a')).toBe(33);
  });

  it('grid state for one project does not leak into another on switch', () => {
    setProjectGridActive('grid-a', true);
    setProjectGridSliderValue('grid-a', 80);
    setActiveProject(projB);
    expect(getProjectGridActive('grid-b')).toBe(false);
    expect(getProjectGridSliderValue('grid-b')).toBe(33);
  });
});
