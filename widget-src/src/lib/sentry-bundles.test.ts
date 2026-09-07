import { afterAll, describe, expect, it, vi } from 'vitest';
import { eventFiltersIntegration, type Client, type Event } from '@sentry/core';
import * as Sentry from '@sentry/react';
import { initSentry } from './sentry';
import shopify from '../../vite.config.shopify-prod';
import upload from '../../vite.config.upload';
import siteChat from '../../vite.config.site-chat';
import chatbot from '../../vite.config.chatbot';

vi.mock('@sentry/react', async (original) => ({
  ...await original<typeof import('@sentry/react')>(), init: vi.fn(),
}));

// US-20: run the actual SDK filter against the options production initializes,
// rather than asserting only that our own regular expressions match themselves.
vi.stubGlobal('window', { location: { hostname: 'drstanfield.com' } });
initSentry();
afterAll(() => { vi.unstubAllGlobals(); });
const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
const client = { getOptions: () => options } as Client;
const extension = 'https://cdn.shopify.com/extensions/synthetic-id/health-roadmap-edu-61/assets/';

function accepted(filename: string): boolean {
  const event: Event = { exception: { values: [{ type: 'Error', value: 'Synthetic bundle-filter probe',
    stacktrace: { frames: [{ filename, function: 'probe', lineno: 1, colno: 1 }] },
  }] } };
  const filter = eventFiltersIntegration();
  return filter.processEvent!(event, {}, client) !== null;
}

describe('production Sentry bundle filters', () => {
  const mainOutput = shopify.build!.rollupOptions!.output as { entryFileNames: string; chunkFileNames: string };
  const current = [mainOutput.entryFileNames, mainOutput.chunkFileNames.replace('[name]', 'HistoryPanel'),
    ...[upload, siteChat, chatbot].map(config => {
      const lib = config.build!.lib;
      if (!lib || typeof lib.fileName !== 'function') throw new Error('Expected an explicit bundle filename');
      return lib.fileName('iife', 'index');
    }),
  ];

  it.each(current)('accepts the emitted Shopify asset %s', name => {
    expect(accepted(extension + name)).toBe(true);
    expect(accepted(extension + name + '?v=123')).toBe(true);
  });

  it.each([
    'https://drbradstanfield.github.io/roadmap/assets/main-test123.js',
    'https://drbradstanfield.github.io/roadmap/assets/HistoryPanel-test123.js',
    'https://drbradstanfield.github.io/roadmap/health-upload.js',
  ])('accepts our Pages asset %s', url => expect(accepted(url)).toBe(true));

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
