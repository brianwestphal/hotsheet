import { describe, expect, it } from 'vitest';

import {
  ipv4InCidr,
  isCgnatIpv4,
  isExposedBind,
  isLoopbackHost,
  isRequestTrusted,
  isTrustedOrigin,
} from './trusted-origin.js';

describe('isLoopbackHost', () => {
  it('recognizes localhost / 127.0.0.1 / ::1', () => {
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('LOCALHOST')).toBe(true);
  });
  it('rejects non-loopback hosts', () => {
    expect(isLoopbackHost('192.168.1.5')).toBe(false);
    expect(isLoopbackHost('example.com')).toBe(false);
    expect(isLoopbackHost('100.64.0.1')).toBe(false);
  });
});

describe('ipv4InCidr', () => {
  it('matches inside the range and rejects outside', () => {
    expect(ipv4InCidr('10.0.0.5', '10.0.0.0/8')).toBe(true);
    expect(ipv4InCidr('10.255.255.255', '10.0.0.0/8')).toBe(true);
    expect(ipv4InCidr('11.0.0.1', '10.0.0.0/8')).toBe(false);
    expect(ipv4InCidr('192.168.1.10', '192.168.1.0/24')).toBe(true);
    expect(ipv4InCidr('192.168.2.10', '192.168.1.0/24')).toBe(false);
  });
  it('handles /0 (everything) and /32 (single host)', () => {
    expect(ipv4InCidr('8.8.8.8', '0.0.0.0/0')).toBe(true);
    expect(ipv4InCidr('1.2.3.4', '1.2.3.4/32')).toBe(true);
    expect(ipv4InCidr('1.2.3.5', '1.2.3.4/32')).toBe(false);
  });
  it('returns false for malformed input', () => {
    expect(ipv4InCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipv4InCidr('10.0.0.1', 'garbage')).toBe(false);
    expect(ipv4InCidr('10.0.0.1', '10.0.0.0/99')).toBe(false);
    expect(ipv4InCidr('999.0.0.1', '10.0.0.0/8')).toBe(false);
  });
});

describe('isCgnatIpv4 (Tailscale 100.64.0.0/10)', () => {
  it('matches the CGNAT block', () => {
    expect(isCgnatIpv4('100.64.0.1')).toBe(true);
    expect(isCgnatIpv4('100.100.50.2')).toBe(true);
    expect(isCgnatIpv4('100.127.255.255')).toBe(true);
  });
  it('rejects addresses just outside the block', () => {
    expect(isCgnatIpv4('100.63.255.255')).toBe(false);
    expect(isCgnatIpv4('100.128.0.0')).toBe(false);
    expect(isCgnatIpv4('99.64.0.1')).toBe(false);
  });
});

describe('isTrustedOrigin', () => {
  it('always trusts localhost regardless of the allow-list', () => {
    expect(isTrustedOrigin('http://localhost:4174', [])).toBe(true);
    expect(isTrustedOrigin('http://127.0.0.1:4174', [])).toBe(true);
    expect(isTrustedOrigin('http://[::1]:4174', [])).toBe(true);
  });
  it('rejects an unknown origin with an empty allow-list', () => {
    expect(isTrustedOrigin('https://evil.example.com', [])).toBe(false);
    expect(isTrustedOrigin('http://100.64.0.5', [])).toBe(false);
  });
  it('returns false for undefined / unparseable values', () => {
    expect(isTrustedOrigin(undefined, [])).toBe(false);
    expect(isTrustedOrigin('', [])).toBe(false);
    expect(isTrustedOrigin('::::not a url', [])).toBe(false);
  });
  it('trusts a host listed by bare hostname', () => {
    expect(isTrustedOrigin('https://my-nas.local:4174', ['my-nas.local'])).toBe(true);
    expect(isTrustedOrigin('https://other.local', ['my-nas.local'])).toBe(false);
  });
  it('trusts a host listed as a full origin URL (host-matched, port-agnostic)', () => {
    expect(isTrustedOrigin('http://10.0.0.4:4174', ['http://10.0.0.4:9999'])).toBe(true);
  });
  it('trusts the CGNAT block via the "tailscale" keyword or the CIDR', () => {
    expect(isTrustedOrigin('http://100.96.1.2:4174', ['tailscale'])).toBe(true);
    expect(isTrustedOrigin('http://100.96.1.2:4174', ['100.64.0.0/10'])).toBe(true);
    // Without opting in, a tailnet IP is NOT trusted.
    expect(isTrustedOrigin('http://100.96.1.2:4174', [])).toBe(false);
  });
  it('trusts a host inside an arbitrary configured CIDR', () => {
    expect(isTrustedOrigin('http://192.168.1.50', ['192.168.1.0/24'])).toBe(true);
    expect(isTrustedOrigin('http://192.168.2.50', ['192.168.1.0/24'])).toBe(false);
  });
  it('ignores blank allow-list entries', () => {
    expect(isTrustedOrigin('https://evil.com', ['', '  '])).toBe(false);
  });
});

describe('isRequestTrusted', () => {
  it('trusts when EITHER origin or referer is trusted', () => {
    expect(isRequestTrusted('http://localhost', undefined, [])).toBe(true);
    expect(isRequestTrusted(undefined, 'http://localhost/x', [])).toBe(true);
    expect(isRequestTrusted('https://evil.com', 'http://localhost/x', [])).toBe(true);
  });
  it('is untrusted when both are absent or untrusted', () => {
    expect(isRequestTrusted(undefined, undefined, [])).toBe(false);
    expect(isRequestTrusted('https://evil.com', 'https://evil.com/x', [])).toBe(false);
  });
});

describe('isExposedBind', () => {
  it('treats loopback / empty as not exposed', () => {
    expect(isExposedBind('127.0.0.1')).toBe(false);
    expect(isExposedBind('localhost')).toBe(false);
    expect(isExposedBind('::1')).toBe(false);
    expect(isExposedBind('')).toBe(false);
  });
  it('treats 0.0.0.0 / :: / a specific IP as exposed', () => {
    expect(isExposedBind('0.0.0.0')).toBe(true);
    expect(isExposedBind('::')).toBe(true);
    expect(isExposedBind('192.168.1.10')).toBe(true);
    expect(isExposedBind('100.96.1.2')).toBe(true);
  });
});
