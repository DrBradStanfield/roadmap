// US-09 AC31 (GHSA-m5fr-866c-fc8x): the Shopify session store reaches Postgres
// only over TLS in production. The store library drops the URL's query string,
// so `sslmode` there does nothing; only PGSSLMODE turns TLS on.
import { describe, it, expect, vi, afterEach } from 'vitest';
import net from 'node:net';
import { assertSessionDbTls } from './session-db-tls.server';

describe('assertSessionDbTls (US-09 AC31)', () => {
  it.each([undefined, '', 'disable', 'allow', 'prefer', 'REQUIRE'])(
    'refuses production with PGSSLMODE=%s',
    (mode) => {
      expect(() => assertSessionDbTls({ NODE_ENV: 'production', PGSSLMODE: mode })).toThrow(/PGSSLMODE/);
    },
  );

  it.each(['require', 'verify-ca', 'verify-full', 'no-verify'])('accepts production with PGSSLMODE=%s', (mode) => {
    expect(() => assertSessionDbTls({ NODE_ENV: 'production', PGSSLMODE: mode })).not.toThrow();
  });

  it('leaves development and tests alone', () => {
    expect(() => assertSessionDbTls({ NODE_ENV: 'development' })).not.toThrow();
    expect(() => assertSessionDbTls({ NODE_ENV: 'test' })).not.toThrow();
  });
});

describe('shopify.server wiring (US-09 AC31)', () => {
  const saved = { NODE_ENV: process.env.NODE_ENV, PGSSLMODE: process.env.PGSSLMODE };
  afterEach(() => {
    process.env.NODE_ENV = saved.NODE_ENV;
    if (saved.PGSSLMODE === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = saved.PGSSLMODE;
    vi.resetModules();
    vi.doUnmock('@shopify/shopify-app-session-storage-postgresql');
  });

  it('refuses to build the session store in production without PGSSLMODE', async () => {
    const constructed = vi.fn();
    vi.doMock('@shopify/shopify-app-session-storage-postgresql', () => ({
      PostgreSQLSessionStorage: class { constructor() { constructed(); } },
    }));
    process.env.NODE_ENV = 'production';
    delete process.env.PGSSLMODE;
    await expect(import('../shopify.server')).rejects.toThrow(/PGSSLMODE/);
    expect(constructed).not.toHaveBeenCalled();
  });
});

// The premise of the guard, against the real store and pg from the lockfile:
// the first packet to a loopback listener is an SSLRequest only when PGSSLMODE
// asks for TLS, whatever the URL says. Synthetic credentials, nothing leaves 127.0.0.1.
describe('the real session store and PGSSLMODE (US-09 AC31 premise)', () => {
  const SSL_REQUEST = 80877103;
  const saved = process.env.PGSSLMODE;
  afterEach(() => {
    if (saved === undefined) delete process.env.PGSSLMODE; else process.env.PGSSLMODE = saved;
  });

  async function firstPacketIsSslRequest(query: string): Promise<boolean> {
    const { PostgreSQLSessionStorage } = await import('@shopify/shopify-app-session-storage-postgresql');
    let resolveFirst!: (b: Buffer) => void;
    const first = new Promise<Buffer>((r) => { resolveFirst = r; });
    const server = net.createServer((socket) => {
      socket.once('data', (chunk) => { resolveFirst(chunk); socket.destroy(); });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as net.AddressInfo;
    const storage = new PostgreSQLSessionStorage(`postgres://synthetic:synthetic@127.0.0.1:${port}/synthetic${query}`);
    // The listener hangs up after one packet; swallow the store's own failed startup.
    storage.ready.catch(() => {});
    (storage as unknown as { migrator: { ready: Promise<void> } }).migrator.ready.catch(() => {});
    try {
      const chunk = await first;
      return chunk.length >= 8 && chunk.readInt32BE(4) === SSL_REQUEST;
    } finally {
      server.close();
    }
  }

  it('ignores sslmode in the URL when PGSSLMODE is unset', async () => {
    delete process.env.PGSSLMODE;
    expect(await firstPacketIsSslRequest('?sslmode=require')).toBe(false);
  });

  it('asks for TLS when PGSSLMODE=require', async () => {
    process.env.PGSSLMODE = 'require';
    expect(await firstPacketIsSslRequest('')).toBe(true);
  });
});
