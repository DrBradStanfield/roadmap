/**
 * One synthetic event through BOTH beforeSend hooks. Lives in widget-src (not
 * health-core) because it imports the browser hook; health-core's tsconfig
 * has rootDir=src and must not reach outside it.
 */
import { describe, it, expect } from 'vitest';
import { scrubEvent } from './sentry';
// @ts-expect-error -- plain .mjs script with no declarations; this parity test
// only needs its runtime exports.
import * as copy from '../../../instrument-scrub.mjs';

// ---------------------------------------------------------------------------
// The two hooks are separate code (the browser drops third-party noise, the
// server drops console breadcrumbs), so behaviour drifted once already: the
// browser reduced breadcrumb URLs to their origin and the server kept the full
// path; the server dropped long strings and the browser kept them. One event
// through both is the guard that neither half loses a step again.

const syntheticEvent = () => ({
  message: 'My LDL is 3.2 mmol/L and cortisol 550',
  exception: {
    values: [{
      type: 'Error',
      value: 'Upload failed for HbA1c 42 mmol/mol',
      stacktrace: { frames: [{ filename: 'app/routes/upload.ts', lineno: 12 }] },
    }],
  },
  extra: {
    accessToken: 'sl.ABC-secret',
    note: 'fasting bloods',
    detail: 'waist 101 cm',
    paste: 'x'.repeat(300),
    status: 200,
  },
  tags: { area: 'chat' },
  breadcrumbs: [{
    category: 'fetch',
    data: {
      method: 'POST',
      url: 'https://content.dropboxapi.com/2/files/download?path=/Apps/roadmap/Brad%20lipids.pdf',
      body: 'health payload',
      // Unlisted by any denylist — the allowlist is what drops it.
      input: { hba1c: 41 },
      status_code: 200,
    },
  }],
  request: { url: 'https://drstanfield.com/apps/health-tool-1/api/chat?token=abc', headers: {} },
});

describe('beforeSend pipeline parity (browser ↔ server)', () => {
  it('scrubs one synthetic event to the same output on both sides', () => {
    const browser = scrubEvent(syntheticEvent() as never) as unknown as Record<string, unknown>;
    const server = copy.scrubServerEvent(syntheticEvent()) as Record<string, unknown>;

    expect(browser).toEqual(server);
    // …and what that output must actually be: no token, no value, no path, no paste.
    expect(browser.extra).toEqual({
      accessToken: '[Filtered]', note: '[Filtered]', detail: 'waist [value]', status: 200,
    });
    expect(browser.message).toBe('My LDL is [value] and cortisol [value]');
    expect((browser.breadcrumbs as Array<{ data: Record<string, unknown> }>)[0].data)
      .toEqual({ method: 'POST', url: 'https://content.dropboxapi.com', status_code: 200 });
    expect((browser.request as { url: string }).url)
      .toBe('https://drstanfield.com/apps/health-tool-1/api/chat');
    // Stack frames are not extra: a filename is never a key, so it survives whole.
    const frames = (browser.exception as { values: Array<{ stacktrace: { frames: Array<{ filename: string }> } }> })
      .values[0].stacktrace.frames;
    expect(frames[0].filename).toBe('app/routes/upload.ts');
  });

  it('drops a request query naming a clinical document, on both sides', () => {
    const withDownload = () => ({
      ...syntheticEvent(),
      request: {
        url: 'https://content.dropboxapi.com/2/files/download?path=/Apps/roadmap/Jane%20Roe%20lipids.pdf',
        query_string: 'path=/Apps/roadmap/Jane%20Roe%20lipids.pdf',
        headers: {},
      },
    });
    const browser = scrubEvent(withDownload() as never) as unknown as Record<string, unknown>;
    const server = copy.scrubServerEvent(withDownload()) as Record<string, unknown>;
    expect(browser).toEqual(server);
    const request = browser.request as { url: string; query_string?: string };
    expect(request.url).toBe('https://content.dropboxapi.com/2/files/download');
    expect(request.url).not.toContain('?');
    expect(request.query_string).toBeUndefined();
  });
});
