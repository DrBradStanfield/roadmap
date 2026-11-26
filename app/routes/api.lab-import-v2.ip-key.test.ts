/**
 * US-52 AC4k (untangle S-21): the website's per-IP daily file limit keys on the one per-IP bucket,
 * read where the app proxy's trusted hop sits. Its own file: the machine's shared file cap is
 * module-global and these cases spend about a thousand files.
 */
import { beforeEach, describe, vi } from 'vitest';

const extractOrClassify = vi.fn();

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('../lib/anthropic.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  extractOrClassify: (...a: unknown[]) => extractOrClassify(...(a as [])),
}));
vi.mock('../lib/local-first-route.server', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  verifyAppProxySignature: () => true,
}));

import { machineFiles } from '../lib/rate-limiter';
import { action } from './api.lab-import-v2';
import { ipKeyedLimitCases } from '../lib/ip-key.test-helpers';

const SHOPIFY_EGRESS = '35.1.2.3';
const PAGES = [{ type: 'image', content: 'AAAA', mimeType: 'image/png' }];

beforeEach(() => {
  machineFiles.reset();
  extractOrClassify.mockResolvedValue({ classification: 'other' });
});

describe('US-52 AC4k: the lab upload files limit per IP keys on the one per-IP bucket', () => {
  ipKeyedLimitCases({
    limit: 200, windowMs: 24 * 60 * 60_000, v6: '2001:db8:1ab', v4: '100.78',
    allowed: async (ip) => (await action({
      request: new Request('https://health-tool-app.fly.dev/api/lab-import-v2', {
        method: 'POST',
        headers: { 'fly-client-ip': SHOPIFY_EGRESS, 'x-forwarded-for': `${ip}, ${SHOPIFY_EGRESS}` },
        body: JSON.stringify({ pages: PAGES }),
      }),
    } as never)).status !== 429,
  });
});
