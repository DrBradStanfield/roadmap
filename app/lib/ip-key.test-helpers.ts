/**
 * The cases every per-IP limit must pass (US-52 AC4k, untangle S-21): its key
 * is the one bucket (`ipBucket` in ip-key.server.ts), its count and window
 * are what they were, and where an IPv6 /64 gets a higher number, each kind
 * of key gets its own. Each route's test file calls this once per limit, with
 * `allowed` placing the address where that route's trusted reader looks.
 */
import { expect, it, vi } from 'vitest';

export interface IpLimit {
  /** The limit for an IPv4 key and the `unknown` key. */
  limit: number;
  /** The limit for an IPv6 /64, where it differs (perKindLimit): it can hold many people. */
  v6Limit?: number;
  windowMs: number;
  /** One request from `ip`; true when the limit let it through. */
  allowed: (ip: string) => Promise<boolean>;
  /** An IPv6 /48 (`2001:db8:N`) and an IPv4 /16 (`100.N`) no other case in the file uses. */
  v6: string;
  v4: string;
}

export function ipKeyedLimitCases({ limit, v6Limit = limit, windowMs, allowed, v6, v4 }: IpLimit): void {
  const spend = async (ip: string, n = ip.includes(':') ? v6Limit : limit) => {
    for (let i = 0; i < n; i++) expect(await allowed(ip), `request ${i + 1} of ${n}`).toBe(true);
  };

  if (v6Limit !== limit) {
    it.each([
      ['an IPv4 address', `${v4}.4.1`, limit],
      ['an IPv6 /64', `${v6}:4::1`, v6Limit],
      ['a value that is not an address', 'not-an-address-0', limit],
    ])('%s gets its own number, then refuses the next', async (_, ip, n) => {
      await spend(ip, n);
      expect(await allowed(ip)).toBe(false);
    });
  }

  it('two addresses in one IPv6 /64 share one budget', async () => {
    await spend(`${v6}:1::1`);
    expect(await allowed(`${v6}:1:ffff:ffff:ffff:ffff`)).toBe(false);
  });

  it('two IPv6 /64s keep their own budgets', async () => {
    await spend(`${v6}:2::1`);
    expect(await allowed(`${v6}:3::1`)).toBe(true);
  });

  it('two IPv4 neighbours keep their own budgets', async () => {
    await spend(`${v4}.1.1`);
    expect(await allowed(`${v4}.1.2`)).toBe(true);
  });

  it('the count and the window are unchanged', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() });
    try {
      const start = Date.now();
      await spend(`${v4}.2.1`);
      expect(await allowed(`${v4}.2.1`)).toBe(false);
      vi.setSystemTime(start + windowMs - 1);
      expect(await allowed(`${v4}.2.1`)).toBe(false);
      vi.setSystemTime(start + windowMs);
      expect(await allowed(`${v4}.2.1`)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('values that are not addresses share one budget, and never spend a readable address', async () => {
    let served = 0;
    while (served <= limit && (await allowed('not-an-address-1'))) served++;
    expect(served).toBeLessThanOrEqual(limit);
    expect(await allowed('not-an-address-2')).toBe(false);
    expect(await allowed(`${v4}.3.1`)).toBe(true);
  });
}
