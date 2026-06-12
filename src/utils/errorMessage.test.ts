import { describe, expect, it } from 'vitest';

import { getErrorMessage } from './errorMessage.js';

describe('getErrorMessage', () => {
  it('returns an Error instance message', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  it('preserves the message of an Error subclass', () => {
    class MyErr extends Error {}
    expect(getErrorMessage(new MyErr('subclass'))).toBe('subclass');
  });

  it('stringifies a non-Error value', () => {
    expect(getErrorMessage('plain string')).toBe('plain string');
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });
});
