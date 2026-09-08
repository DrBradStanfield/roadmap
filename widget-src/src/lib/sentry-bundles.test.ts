import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { eventFiltersIntegration, type Client, type Event } from '@sentry/core';
import * as Sentry from '@sentry/react';
import { initSentry } from './sentry';

vi.mock('@sentry/react', async (original) => ({
  ...await original<typeof import('@sentry/react')>(), init: vi.fn(),
}));

// US-15 AC5: run the actual SDK filter against the options production initializes,
// over the bundles the builds actually emit, so a renamed chunk fails here.
vi.stubGlobal('window', { location: { hostname: 'drstanfield.com' } });
initSentry();
afterAll(() => { vi.unstubAllGlobals(); });
const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
const client = { getOptions: () => options } as Client;
const extension = 'https://cdn.shopify.com/extensions/synthetic-id/health-roadmap-edu-61/assets/';
const pages = 'https://drbradstanfield.github.io/roadmap/';

function accepted(filename: string): boolean {
  const event: Event = { exception: { values: [{ type: 'Error', value: 'Synthetic bundle-filter probe',
    stacktrace: { frames: [{ filename, function: 'probe', lineno: 1, colno: 1 }] },
  }] } };
  const filter = eventFiltersIntegration();
  return filter.processEvent!(event, {}, client) !== null;
}

function emittedJs(relative: string): string[] {
  const dir = fileURLToPath(new URL(relative, import.meta.url));
  return existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.js')) : [];
}

describe('production Sentry bundle filters', () => {
  const shopifyAssets = emittedJs('../../../extensions/health-tool-widget/assets/');
  it('sees the committed Shopify bundles', () => {
    expect(shopifyAssets).toContain('health-plan-v2.js');
    expect(shopifyAssets.length).toBeGreaterThanOrEqual(5);
  });

  it.each(shopifyAssets)('accepts the emitted Shopify asset %s', name => {
    expect(accepted(extension + name)).toBe(true);
    expect(accepted(extension + name + '?v=123')).toBe(true);
    expect(accepted(extension + name + '.map')).toBe(false);
  });

  // build:pages output is not committed; enumerate it when a local build exists.
  const pagesAssets = [
    ...emittedJs('../../dist-pages/assets/').map(f => 'assets/' + f),
    ...emittedJs('../../dist-pages/'),
  ];
  describe.skipIf(pagesAssets.length === 0)('Pages build output', () => {
    it.each(pagesAssets)('accepts the emitted Pages asset %s', name => expect(accepted(pages + name)).toBe(true));
  });

  it.each([
    pages + 'assets/main-test123.js',
    pages + 'assets/HistoryPanel-test123.js',
    pages + 'health-upload.js',
  ])('accepts our Pages asset shape %s', url => expect(accepted(url)).toBe(true));

  it.each([
    extension + 'upcart-bundle.js', extension + 'health-tool.js',
    extension + 'health-plan-v2.js.attacker.js',
    'https://evil.example/health-site-chat.js',
    'https://evil.example/?next=' + extension + 'health-plan-v2.js',
    'https://cdn.shopify.com.evil.example/extensions/a/b/assets/health-plan-v2.js',
    'https://drbradstanfield.github.io.evil.example/roadmap/assets/main.js',
    'https://someone.github.io/roadmap/assets/main.js',
  ])('rejects unrelated or misleading source %s', url => expect(accepted(url)).toBe(false));
});
