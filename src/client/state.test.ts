import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearPerProjectSessionState,
  getCategoryColor,
  getCategoryLabel,
  getPriorityColor,
  getPriorityIcon,
  getStatusIcon,
  setActiveProject,
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
