import { describe, expect, it } from 'vitest';

import {
  buildTaskpolicyArgs,
  shouldBumpProcessPriority,
  TASKPOLICY_QOS_CLASS,
} from './processPriority.js';

describe('shouldBumpProcessPriority — pure platform gate', () => {
  it('returns true on darwin', () => {
    expect(shouldBumpProcessPriority('darwin')).toBe(true);
  });

  it('returns false on linux', () => {
    expect(shouldBumpProcessPriority('linux')).toBe(false);
  });

  it('returns false on win32', () => {
    expect(shouldBumpProcessPriority('win32')).toBe(false);
  });

  it('returns false on freebsd / openbsd / aix / sunos / android', () => {
    for (const platform of ['freebsd', 'openbsd', 'aix', 'sunos', 'android'] as const) {
      expect(shouldBumpProcessPriority(platform)).toBe(false);
    }
  });
});

describe('buildTaskpolicyArgs — argv builder', () => {
  it('produces `-p <pid> -c user-interactive` by default', () => {
    expect(buildTaskpolicyArgs(12345)).toEqual(['-p', '12345', '-c', 'user-interactive']);
  });

  it('stringifies the pid', () => {
    const args = buildTaskpolicyArgs(7);
    expect(args[1]).toBe('7');
    expect(typeof args[1]).toBe('string');
  });

  it('honours an explicit QoS class override', () => {
    expect(buildTaskpolicyArgs(99, 'user-initiated')).toEqual(['-p', '99', '-c', 'user-initiated']);
  });

  it('default QoS class is the exported constant', () => {
    expect(buildTaskpolicyArgs(1)[3]).toBe(TASKPOLICY_QOS_CLASS);
    expect(TASKPOLICY_QOS_CLASS).toBe('user-interactive');
  });
});
