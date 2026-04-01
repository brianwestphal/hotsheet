import { describe, expect, it } from 'vitest';

import {
  getCategoryColor,
  getCategoryLabel,
  getPriorityColor,
  getPriorityIcon,
  getStatusIcon,
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
    expect(getPriorityIcon('unknown')).toBe('\u2014');
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
    expect(getStatusIcon('not_started')).toBe('\u25CB');
    expect(getStatusIcon('started')).toBe('\u25D4');
    expect(getStatusIcon('completed')).toBe('\u2713');
    expect(getStatusIcon('verified')).toContain('<svg');
    expect(getStatusIcon('backlog')).toBe('\u25A1');
    expect(getStatusIcon('archive')).toBe('\u25A0');
  });

  it('returns default for unknown status', () => {
    expect(getStatusIcon('unknown')).toBe('\u25CB');
  });
});
