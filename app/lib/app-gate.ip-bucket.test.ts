/**
 * The per-IP bucket key (US-52 AC4g). Pins first: the canonical text Fly and
 * Shopify write today keys exactly as before, so no limiter changes for a
 * normal client.
 */
import { describe, expect, it } from 'vitest';
import { ipBucket } from './app-gate.server';

describe('ipBucket: canonical inputs key as before (US-52 AC4g pin)', () => {
  it.each([
    ['203.0.113.9', '203.0.113.9'],
    ['198.51.100.14', '198.51.100.14'],
    ['0.0.0.0', '0.0.0.0'],
    ['255.255.255.255', '255.255.255.255'],
    ['::ffff:203.0.113.9', '203.0.113.9'],
    ['2001:db8:1:2:aaaa::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2:bbbb:cccc:dddd:eeee', '2001:db8:1:2::/64'],
    ['2001:db8::1', '2001:db8:0:0::/64'],
    ['2a01:4f8:c17:a1b::1', '2a01:4f8:c17:a1b::/64'],
    ['2001:db8:0:a::', '2001:db8:0:a::/64'],
    ['fe80::1', 'fe80:0:0:0::/64'],
    ['::1', '0:0:0:0::/64'],
    ['::', '0:0:0:0::/64'],
    ['unknown', 'unknown'],
  ])('%s -> %s', (input, key) => {
    expect(ipBucket(input)).toBe(key);
  });
});

describe('ipBucket: every spelling of one address is one key (US-52 AC4g)', () => {
  it.each([
    // IPv4-mapped IPv6, any spelling, is the IPv4 address.
    ['::FFFF:203.0.113.9', '203.0.113.9'],
    ['::ffff:cb00:7109', '203.0.113.9'],
    ['::FFFF:CB00:7109', '203.0.113.9'],
    ['0:0:0:0:0:ffff:203.0.113.9', '203.0.113.9'],
    ['0000:0000:0000:0000:0000:ffff:cb00:7109', '203.0.113.9'],
    ['0:0:0:0:0:ffff:cb00:7109', '203.0.113.9'],
    ['[::ffff:203.0.113.9]:443', '203.0.113.9'],
    // IPv6: expanded, uppercase, leading zeros, brackets, port, zone.
    ['2001:0db8:0001:0002:aaaa:0000:0000:0001', '2001:db8:1:2::/64'],
    ['2001:DB8:1:2:AAAA::1', '2001:db8:1:2::/64'],
    ['2001:db8:1:2::', '2001:db8:1:2::/64'],
    ['2001:db8:1::2:3', '2001:db8:1:0::/64'],
    ['[2001:db8:1:2::1]', '2001:db8:1:2::/64'],
    ['[2001:db8:1:2::1]:8080', '2001:db8:1:2::/64'],
    ['fe80::1%eth0', 'fe80:0:0:0::/64'],
    ['[fe80::1%25en0]:443', 'fe80:0:0:0::/64'],
    ['0:0:0:0:0:0:0:1', '0:0:0:0::/64'],
    // IPv4 with a port, and surrounding space.
    ['203.0.113.9:51234', '203.0.113.9'],
    [' 203.0.113.9 ', '203.0.113.9'],
  ])('%s -> %s', (input, key) => {
    expect(ipBucket(input)).toBe(key);
  });

  it.each([
    [''],
    ['   '],
    ['not-an-ip'],
    ['203.000.113.9'],
    ['0203.0.113.9'],
    ['203.0.113'],
    ['203.0.113.9.1'],
    ['256.0.0.1'],
    ['::ffff:203.000.113.9'],
    ['2001:db8::1::2'],
    ['2001:db8:1:2:3:4:5:6:7'],
    ['12345::1'],
    ['[2001:db8::1'],
    ['[203.0.113.9]'],
    ['203.0.113.9:99999'],
    ['203.0.113.9%eth0'],
    ['2001:db8::1, 2001:db8::2'],
  ])('a value that is not an address (%j) is the one fixed key', (input) => {
    expect(ipBucket(input)).toBe('unknown');
  });

  it('a very long value is the one fixed key', () => {
    expect(ipBucket('1:' + 'a'.repeat(5000))).toBe('unknown');
    expect(ipBucket('2001:db8::1%' + 'z'.repeat(5000))).toBe('unknown');
  });

  it('undefined is the one fixed key', () => {
    expect(ipBucket(undefined)).toBe('unknown');
  });

  it('two different invalid values share one key, never their own text', () => {
    expect(ipBucket('x'.repeat(200))).toBe(ipBucket('y'));
  });
});
