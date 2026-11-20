import { describe, expect, it } from 'vitest';

import { assertSafeUrl, isPrivateAddress, normalizeUrl } from './urlSafety.js';

describe('normalizeUrl', () => {
  it('adds https when the scheme is missing', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com');
  });

  it('keeps an explicit http scheme and trims whitespace', () => {
    expect(normalizeUrl('  http://example.com/path  ')).toBe('http://example.com/path');
  });
});

describe('isPrivateAddress', () => {
  it.each([
    '127.0.0.1',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
  ])('treats %s as private', (address) => {
    expect(isPrivateAddress(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.15.0.1',
    '172.32.0.1',
    '100.63.255.255',
    '100.128.0.1',
    '2606:4700:4700::1111',
  ])('treats %s as public', (address) => {
    expect(isPrivateAddress(address)).toBe(false);
  });
});

describe('assertSafeUrl', () => {
  it('allows public HTTP(S) URLs', () => {
    expect(() => assertSafeUrl('https://example.com')).not.toThrow();
    expect(() => assertSafeUrl('http://example.com:8080/path?q=1')).not.toThrow();
  });

  it.each([
    'ftp://example.com',
    'file:///etc/passwd',
    'javascript:alert(1)',
    'http://localhost',
    'http://localhost:3000',
    'http://app.localhost',
    'http://127.0.0.1',
    'http://10.0.0.5',
    'http://192.168.1.10',
    'http://169.254.169.254',
    'http://[::1]',
    'http://2130706433',
    'http://0x7f000001',
    'http://metadata.google.internal',
    'http://user:pass@example.com',
  ])('rejects %s', (url) => {
    expect(() => assertSafeUrl(url)).toThrow();
  });
});
