// US-22 AC10a: partial cleanup must remain retryable and value-free.
import crypto from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@sentry/node', () => ({ captureException: vi.fn() }));
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn() }));
vi.mock('../lib/reminder-v2.server', () => ({ deleteByEmail: vi.fn() }));
vi.mock('../lib/product-events.server', () => ({ recordServerEvent: vi.fn() }));

import * as Sentry from '@sentry/node';
import { deleteByEmail } from '../lib/reminder-v2.server';
import { recordServerEvent } from '../lib/product-events.server';
import { action } from './api.resend-webhook';

const SECRET = 'whsec_' + Buffer.from('synthetic-webhook-key').toString('base64');
const ADDRESS = 'synthetic@example.invalid';
const fetchMock = vi.fn<typeof fetch>();
const deletion = vi.mocked(deleteByEmail);

function signedRequest(rawBody = JSON.stringify({ type: 'email.complained', data: { to: [ADDRESS] } }), timestamp = String(Math.floor(Date.now() / 1000))) {
  const id = 'msg_synthetic';
  const signature = crypto.createHmac('sha256', Buffer.from(SECRET.slice(6), 'base64'))
    .update(`${id}.${timestamp}.${rawBody}`).digest('base64');
  return new Request('https://example.invalid/api/resend-webhook', {
    method: 'POST', body: rawBody,
    headers: { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': `v1,${signature}` },
  });
}

beforeEach(() => {
  vi.stubEnv('RESEND_WEBHOOK_SECRET', SECRET);
  vi.stubEnv('KLAVIYO_API_KEY', 'synthetic-key');
  vi.stubEnv('KLAVIYO_LIST_ID', 'synthetic-list');
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  fetchMock.mockResolvedValue(new Response(null, { status: 202 }));
  deletion.mockResolvedValue(true);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('signed Resend cleanup acknowledgment', () => {
  it('keeps provider and database error content out of logs and telemetry', async () => {
    const privateDetail = `${ADDRESS} synthetic-health-marker=123`;
    fetchMock.mockRejectedValue(new Error(privateDetail));
    deletion.mockRejectedValue(new Error(privateDetail));
    const response = await action({ request: signedRequest() } as never);
    expect(response.status).toBe(503);
    expect(Sentry.captureException).toHaveBeenCalled();
    const diagnostics = JSON.stringify([
      vi.mocked(console.error).mock.calls,
      vi.mocked(console.warn).mock.calls,
      vi.mocked(console.log).mock.calls,
      vi.mocked(Sentry.captureException).mock.calls,
      vi.mocked(recordServerEvent).mock.calls,
    ], (_key, value) => value instanceof Error ? { message: value.message, stack: value.stack } : value);
    expect(diagnostics).not.toContain(ADDRESS);
    expect(diagnostics).not.toContain('synthetic-health-marker');
  });
  it.each(['KLAVIYO_API_KEY', 'KLAVIYO_LIST_ID'])('acknowledges local cleanup when %s is unconfigured', async (setting) => {
    vi.stubEnv(setting, '');
    const response = await action({ request: signedRequest() } as never);
    expect(response.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletion).toHaveBeenCalledWith(ADDRESS);
  });
  it.each([400, 429, 503])('requests retry on Klaviyo HTTP %s even when local cleanup succeeds', async (status) => {
    fetchMock.mockResolvedValue(new Response('provider body must not be logged', { status }));
    const response = await action({ request: signedRequest() } as never);
    expect(response.status).toBe(503);
    expect(deletion).toHaveBeenCalledWith(ADDRESS);
    expect(recordServerEvent).not.toHaveBeenCalled();
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error), { tags: { feature: 'resend_webhook', step: 'klaviyo' } },
    );
  });

  it('requests retry when only reminder cleanup fails', async () => {
    deletion.mockRejectedValue(new Error('synthetic outage'));
    expect((await action({ request: signedRequest() } as never)).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  it('still requests retry for local failure when Klaviyo is unconfigured', async () => {
    vi.stubEnv('KLAVIYO_API_KEY', '');
    deletion.mockRejectedValue(new Error('synthetic outage'));
    expect((await action({ request: signedRequest() } as never)).status).toBe(503);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([true, false])('acknowledges successful cleanup when deletion reports %s (false means already absent)', async (deleted) => {
    deletion.mockResolvedValue(deleted);
    const response = await action({ request: signedRequest() } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: 'complained', count: 1 });
    expect(recordServerEvent).toHaveBeenCalledExactlyOnceWith('report_email_complained');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('finishes every address despite partial failure and safely repeats cleanup on redelivery', async () => {
    const second = 'second@example.invalid';
    const body = JSON.stringify({ type: 'email.complained', data: { to: [ADDRESS, second] } });
    // Model the database boundary: the first delivery deletes both rows even
    // though its first remote suppression fails. A retry finds no local rows.
    const enrolled = new Set([ADDRESS, second]);
    const deletedRows: string[] = [];
    deletion.mockImplementation(async (email) => {
      const removed = enrolled.delete(email);
      if (removed) deletedRows.push(email);
      return removed;
    });
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 503 }));
    expect((await action({ request: signedRequest(body) } as never)).status).toBe(503);
    expect(deletion.mock.calls).toEqual([[ADDRESS], [second]]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(recordServerEvent).not.toHaveBeenCalled();

    const retry = await action({ request: signedRequest(body) } as never);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ ok: true, action: 'complained', count: 2 });
    expect(deletedRows).toEqual([ADDRESS, second]);
    expect(deletion.mock.calls).toEqual([[ADDRESS], [second], [ADDRESS], [second]]);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe('https://a.klaviyo.com/api/profile-subscription-bulk-delete-jobs/');
      expect(init?.method).toBe('POST');
      const job = JSON.parse(String(init?.body));
      expect(job.data.type).toBe('profile-subscription-bulk-delete-job');
      expect(job.data.attributes.profiles.data[0].attributes).toEqual({
        email: expect.stringMatching(/^(synthetic|second)@example\.invalid$/),
      });
    }
    expect(recordServerEvent).toHaveBeenCalledExactlyOnceWith('report_email_complained');
  });

  it('continues to later addresses after an earlier reminder deletion rejects', async () => {
    const second = 'second@example.invalid';
    deletion.mockRejectedValueOnce(new Error('synthetic outage'));
    const body = JSON.stringify({ type: 'email.complained', data: { to: [ADDRESS, second] } });
    expect((await action({ request: signedRequest(body) } as never)).status).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(deletion.mock.calls).toEqual([[ADDRESS], [second]]);
  });

  it('cleans up permanent bounces through the same handler', async () => {
    const body = JSON.stringify({ type: 'email.bounced', data: { to: [ADDRESS], bounce: { type: 'Permanent' } } });
    const response = await action({ request: signedRequest(body) } as never);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, action: 'bounced', count: 1 });
    expect(recordServerEvent).toHaveBeenCalledExactlyOnceWith('report_email_bounced');
  });

  it.each(['email.delivered', 'email.bounced'])('ignores %s without a permanent bounce', async (type) => {
    const body = JSON.stringify({ type, data: { to: [ADDRESS], bounce: { type: 'Transient' } } });
    const response = await action({ request: signedRequest(body) } as never);
    expect(await response.json()).toEqual({ ok: true, action: 'ignored' });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  it.each(['unsigned', 'tampered', 'stale', 'unconfigured'])('rejects %s requests before cleanup', async (mode) => {
    let request = signedRequest();
    if (mode === 'unsigned') request.headers.delete('svix-signature');
    if (mode === 'tampered') request = new Request(request.url, { method: 'POST', headers: request.headers, body: '{}' });
    if (mode === 'stale') request = signedRequest('{}', String(Math.floor(Date.now() / 1000) - 3600));
    if (mode === 'unconfigured') vi.stubEnv('RESEND_WEBHOOK_SECRET', '');
    expect((await action({ request } as never)).status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
    expect(recordServerEvent).not.toHaveBeenCalled();
  });

  it('rejects oversized bodies before cleanup', async () => {
    const request = signedRequest('x'.repeat(256 * 1024 + 1));
    request.headers.delete('svix-signature');
    expect((await action({ request } as never)).status).toBe(413);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
  });

  it('rejects signed malformed JSON before cleanup', async () => {
    expect((await action({ request: signedRequest('{') } as never)).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
  });

  it('rejects non-POST methods before cleanup', async () => {
    const request = new Request('https://example.invalid/api/resend-webhook');
    expect((await action({ request } as never)).status).toBe(405);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deletion).not.toHaveBeenCalled();
  });

  it('requests retry when suppression returns false and reminder deletion rejects', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 503 }));
    deletion.mockRejectedValue(new Error('synthetic database outage'));
    const response = await action({ request: signedRequest() } as never);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deletion).toHaveBeenCalledWith(ADDRESS);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ ok: false, error: 'Cleanup incomplete' });
    expect(recordServerEvent).not.toHaveBeenCalled();
  });
});
