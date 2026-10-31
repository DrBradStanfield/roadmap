// @vitest-environment jsdom
/**
 * US-20 AC5: Sentry stays off on every loopback host, and on for the live site.
 * Pins the value actually handed to Sentry.init, not just the host check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const init = vi.hoisted(() => vi.fn());
vi.mock('@sentry/react', async (original) => ({ ...(await original<typeof import('@sentry/react')>()), init }));

declare const jsdom: { reconfigure: (o: { url: string }) => void };

beforeEach(() => { init.mockClear(); vi.resetModules(); });

async function initOn(url: string) {
  jsdom.reconfigure({ url });
  const { initSentry } = await import('./sentry');
  initSentry();
  return init.mock.calls.at(-1)![0] as { enabled: boolean; environment: string };
}

describe('US-20 AC5 — Sentry.init on each host', () => {
  it.each(['http://localhost:5174/', 'http://127.0.0.1:5174/', 'http://[::1]:5174/'])('%s: disabled, development', async (url) => {
    expect(await initOn(url)).toMatchObject({ enabled: false, environment: 'development' });
  });

  it('drstanfield.com: enabled, production', async () => {
    expect(await initOn('https://drstanfield.com/pages/roadmap')).toMatchObject({ enabled: true, environment: 'production' });
  });
});
