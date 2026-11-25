/**
 * US-09 — server-api calls that need Brad's server must no-op on the GitHub
 * Pages build, so the Pages bundle never ships the fetch.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./sentry', () => ({ Sentry: { captureException: vi.fn() } }));

function stubFetch() {
  const fetchMock = vi.fn().mockResolvedValue(new Response('{"success":true}', { headers: { 'content-type': 'application/json' } }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

async function loadApi(shopify: boolean) {
  vi.resetModules();
  vi.doMock('./build-flags', () => ({ SHOPIFY_SURFACE: shopify, LOCAL_FIRST: true }));
  return import('./server-api');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock('./build-flags');
  vi.resetModules();
});

describe('sendFeedback', () => {
  it('reports failure without fetching on the Pages build', async () => {
    const fetchMock = stubFetch();
    const { sendFeedback } = await loadApi(false);
    await expect(sendFeedback('a@b.com', 'hi')).resolves.toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('POSTs to the app proxy on the Shopify surface', async () => {
    const fetchMock = stubFetch();
    const { sendFeedback } = await loadApi(true);
    await expect(sendFeedback('a@b.com', 'hi')).resolves.toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe('/apps/health-tool-1/api/feedback');
  });
});

describe('A/B tracking, retired (US-09 AC60)', () => {
  // Brad, 2026-11-26: the old A/B event calls are deleted. Nothing assigns a variant, so the
  // calls, their stored-assignment reader and the endpoint that took them go together.
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const sources = (dir: string): string[] =>
    readdirSync(join(root, dir), { recursive: true, encoding: 'utf8' })
      .filter((f) => /\.(tsx?|liquid)$/.test(f) && !/\.test\.tsx?$/.test(f))
      .map((f) => join(dir, f));

  it('no widget, theme block or app source sends, reads or serves an A/B event', () => {
    const named = [...sources('widget-src/src'), ...sources('extensions/health-tool-widget/blocks'), ...sources('app')]
      .filter((f) => /\/api\/ab\b|hr_ab|trackAB|getABAssignments|recordABEvent/.test(readFileSync(join(root, f), 'utf8')));
    expect(named).toEqual([]);
    expect(existsSync(join(root, 'app/routes/api.ab.ts'))).toBe(false);
  });

  it('server-api exports no A/B tracker, and the visitor id product events use stays', async () => {
    const api: Record<string, unknown> = await loadApi(true);
    expect(Object.keys(api).filter((k) => /AB/.test(k))).toEqual([]);
    expect(typeof api.getVisitorId).toBe('function');
  });
});
