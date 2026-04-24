import { describe, expect, it } from 'vitest';

import { formatCwdLabel, parseOsc7Payload } from './terminalOsc7.js';

describe('parseOsc7Payload (HS-7262)', () => {
  it('parses the standard file://HOST/PATH form', () => {
    expect(parseOsc7Payload('file://myhost/Users/me/Documents/hotsheet')).toBe('/Users/me/Documents/hotsheet');
  });

  it('parses the empty-host form file:///PATH', () => {
    expect(parseOsc7Payload('file:///Users/me')).toBe('/Users/me');
  });

  it('decodes percent-encoded path segments', () => {
    // Real emitters URL-encode space, non-ASCII, and special chars in paths.
    expect(parseOsc7Payload('file://host/Users/me/My%20Projects/%E2%9C%93-done'))
      .toBe('/Users/me/My Projects/✓-done');
  });

  it('returns null when the prefix is not file://', () => {
    expect(parseOsc7Payload('http://host/path')).toBeNull();
    expect(parseOsc7Payload('ssh://host/path')).toBeNull();
    expect(parseOsc7Payload('not a url')).toBeNull();
  });

  it('returns null on empty payload', () => {
    expect(parseOsc7Payload('')).toBeNull();
  });

  it('returns null when no path segment is present (host only)', () => {
    expect(parseOsc7Payload('file://hostname')).toBeNull();
  });

  it('returns null on malformed percent encoding rather than garbled text', () => {
    expect(parseOsc7Payload('file://host/bad-%E0-encoding')).toBeNull();
  });

  it('preserves trailing slash if the shell pushed it', () => {
    expect(parseOsc7Payload('file://host/Users/me/')).toBe('/Users/me/');
  });
});

describe('formatCwdLabel (HS-7262)', () => {
  it('returns the path unchanged when no tildification applies', () => {
    expect(formatCwdLabel('/short/path', null)).toBe('/short/path');
  });

  it('tildifies the home directory itself', () => {
    expect(formatCwdLabel('/Users/me', '/Users/me')).toBe('~');
  });

  it('tildifies paths under home', () => {
    expect(formatCwdLabel('/Users/me/Documents', '/Users/me')).toBe('~/Documents');
  });

  it('does NOT tildify paths that only share a prefix with home (e.g. sibling dirs)', () => {
    // /Users/me-other starts with /Users/me but is NOT under /Users/me.
    expect(formatCwdLabel('/Users/me-other/stuff', '/Users/me')).toBe('/Users/me-other/stuff');
  });

  it('returns the path unchanged when home is null (unknown $HOME)', () => {
    expect(formatCwdLabel('/Users/me/Documents', null)).toBe('/Users/me/Documents');
  });

  it('truncates very long paths to the last two segments', () => {
    const long = '/a/very/deeply/nested/path/to/some/project';
    expect(formatCwdLabel(long, null)).toBe('…/some/project');
  });

  it('preserves tilde prefix when truncating a home-relative long path', () => {
    const long = '/Users/me/some/very/deeply/nested/path/to/target';
    expect(formatCwdLabel(long, '/Users/me')).toBe('~/…/to/target');
  });

  it('does not truncate short paths even with many segments', () => {
    expect(formatCwdLabel('/a/b/c/d', null)).toBe('/a/b/c/d');
  });
});
