// HS-9303 — remote-server URL normalization (docs/112 §112.6).
import { describe, expect, it } from 'vitest';

import { isLoopbackOrigin, normalizeServerUrl } from './remoteUrl.js';

function origin(input: string): string {
  const r = normalizeServerUrl(input);
  if (!r.ok) throw new Error(`expected ok for ${input}: ${r.error}`);
  return r.origin;
}

describe('normalizeServerUrl', () => {
  it('defaults a scheme-less entry to https', () => {
    expect(origin('remote.example:4174')).toBe('https://remote.example:4174');
    expect(origin('remote.example')).toBe('https://remote.example');
  });

  it('preserves an explicit scheme', () => {
    expect(origin('https://remote.example:4174')).toBe('https://remote.example:4174');
    expect(origin('http://localhost:4174')).toBe('http://localhost:4174');
  });

  it('strips path, query, and trailing slash → canonical origin', () => {
    expect(origin('https://remote.example:4174/')).toBe('https://remote.example:4174');
    expect(origin('https://remote.example:4174/foo/bar?x=1')).toBe('https://remote.example:4174');
  });

  it('lowercases the host + elides default ports', () => {
    expect(origin('HTTPS://Remote.Example')).toBe('https://remote.example');
    expect(origin('https://remote.example:443')).toBe('https://remote.example');
  });

  it('rejects empty input', () => {
    const r = normalizeServerUrl('   ');
    expect(r.ok).toBe(false);
  });

  it('rejects a non-http(s) scheme', () => {
    const r = normalizeServerUrl('ftp://remote.example');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/https/i);
  });

  it('rejects an unparseable URL (exercises the URL() throw path)', () => {
    // An unterminated IPv6 bracket reliably throws in the URL parser.
    expect(normalizeServerUrl('https://[').ok).toBe(false);
  });
});

describe('isLoopbackOrigin', () => {
  it('recognizes loopback hosts', () => {
    expect(isLoopbackOrigin('http://localhost:4174')).toBe(true);
    expect(isLoopbackOrigin('http://127.0.0.1:4174')).toBe(true);
    expect(isLoopbackOrigin('https://remote.example:4174')).toBe(false);
  });
});
