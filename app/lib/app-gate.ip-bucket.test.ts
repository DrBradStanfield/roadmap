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
