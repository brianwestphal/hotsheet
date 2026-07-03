// HS-9144 — branch coverage for the plugin label-color class helper.
import { describe, expect, it } from 'vitest';

import { labelColorClass } from './pluginTypes.js';

describe('labelColorClass', () => {
  it('returns the bare class for undefined / empty / "default"', () => {
    expect(labelColorClass(undefined)).toBe('config-label');
    expect(labelColorClass('')).toBe('config-label');
    expect(labelColorClass('default')).toBe('config-label');
  });

  it('appends a color modifier for a named color', () => {
    expect(labelColorClass('red')).toBe('config-label label-color-red');
    expect(labelColorClass('blue')).toBe('config-label label-color-blue');
  });
});
