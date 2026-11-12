/**
 * Audit A2-6/A3-1, step 1: the server scrub now lives in health-core
 * (sentry-scrub-server.ts) beside the hand copy in instrument-scrub.mjs, until a
 * later change generates the .mjs from it. Until then the two must give the
 * same output for the same event, whatever its shape. The vocabulary both
 * scrubbers share is a leaf module, so a bundle of the server scrub carries
 * the lab catalogue and nothing else.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { scrubServerEvent } from './sentry-scrub-server';
import * as browser from './sentry-scrub';
// @ts-expect-error -- plain .mjs script with no declarations; only its runtime export is used.
import * as copy from '../../../instrument-scrub.mjs';

/** Every module a source file imports, static, re-exported or dynamic. */
const importsOf = (file: string): string[] => {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
};

// Low-entropy ids in the SDK's shapes, each holding a hex lab name and digits.
const TRACE_ID = 'e2123456789abcdef0123456789abcde';
const SPAN_ID = 'e212345678abcdef';
const TEXT = 'LDL 3.2 mmol/L e2 45';

/** Runs both scrubbers on their own deep copy; both throw alike or return equal events. */
function both(make: () => unknown): unknown {
  const run = (scrub: (e: unknown) => unknown) => {
    try { return { ok: scrub(make()) }; } catch (error) { return { threw: `${(error as Error).name}: ${(error as Error).message}` }; }
  };
  const fromCore = run(scrubServerEvent);
  const fromCopy = run(copy.scrubServerEvent);
  expect(fromCore).toEqual(fromCopy);
  return 'ok' in fromCore ? fromCore.ok : fromCore;
}

const incomingTransaction = () => ({
  type: 'transaction',
  transaction: 'GET *',
  contexts: {
    trace: {
      op: 'http.server', trace_id: TRACE_ID, span_id: SPAN_ID, parent_span_id: SPAN_ID,
      links: [{ trace_id: TRACE_ID, span_id: SPAN_ID, sampled: true }, { trace_id: TEXT, span_id: 'e2 45' }],
      data: {
        'http.query': 'path=/Apps/roadmap/lipids.pdf', 'url.full': 'https://shop.test/files/LDL 3.2.pdf?x=1',
        'http.target': '/apps/roadmap/value/ldl%203.2', 'url.path': '/p/e2 45', 'http.route': '/apps/*',
        'http.request.header.cookie': 'session', 'http.request.header.user_agent': 'agent',
        'http.response.header.content_type': 'text/html', 'http.request.header.referer': 'https://shop.test/?q=1',
        'http.client_ip': '10.0.0.1', 'client.address': '10.0.0.1', 'net.peer.name': 'peer', 'network.peer.address': '10.0.0.1',
        'user.ip_address': '10.0.0.1', 'http.status_code': 200, 'sentry.op': 'http.server', weight: 80,
      },
    },
    runtime: { name: 'node', version: 'v22' },
    other: { trace_id: TRACE_ID, note: TEXT },
  },
  spans: [
    { op: 'http.client', description: 'GET https://api.test/files/lipids%20e2%2045.pdf', span_id: SPAN_ID, parent_span_id: SPAN_ID, trace_id: TRACE_ID,
      data: { url: 'https://api.test/files/lipids.pdf?token=t', 'http.query': 'a=b', 'server.address': 'api.test', authorization: 'x', ldl: 3.2, note: TEXT } },
    { op: 'db', description: 'select ldl from rows where e2 = 45', data: { 'db.statement': TEXT, 'db.system': 'postgres' } },
    { op: 'http.client', description: 'not a url', data: null },
    { op: 'http.client', description: 42 },
    { op: 'function' },
  ],
  request: {
    url: 'https://shop.test/apps/roadmap/ldl 3.2?logged_in_customer_id=1', query_string: 'a=1', cookies: { s: '1' },
    data: '{"ldl":3.2}', method: 'POST',
    headers: { Host: 'shop.test', 'User-Agent': 'agent', Cookie: 's=1', Authorization: 'Bearer t', Referer: 'https://shop.test/?q=1',
      'content-type': 'application/json', 'Content-Length': '12', accept: '*/*', 'x-forwarded-for': '10.0.0.1' },
  },
});

const outgoingTransaction = () => ({
  type: 'transaction',
  transaction: 'POST https://api.test/upload/Jane%20Roe%20lipids.pdf?x=1',
  contexts: { trace: { op: 'http.client', trace_id: TRACE_ID, span_id: SPAN_ID,
    data: { url: 'https://api.test/upload/doc.pdf', 'http.query': 'q', 'http.method': 'POST', email: 'a@b.test', note: TEXT } } },
  spans: [{ op: 'http.client', description: 'PUT https://dav.test/remote.php/files/doc.pdf', data: { 'http.url': '/rel/path', target: 'https://dav.test/x' } }],
});

const errorEvent = () => ({
  level: 'error',
  message: 'came back 120 lp(a)',
  logentry: { message: 'ferritin 12 for a@b.test', params: [TEXT, 3] },
  exception: { values: [
    { type: 'Error', value: 'import failed at 33 γ-GT for a@b.test', stacktrace: { frames: [{ filename: 'app/routes/ldl.ts', lineno: 12 }] } },
    { type: 'TypeError', value: 42 },
    { type: 'Error' },
  ] },
  extra: {
    message: TEXT, ldl: 3.2, nested: { deep: { email: 'a@b.test', list: [[TEXT, ['x'.repeat(300)], 7, true, null]] } },
    long: 'y'.repeat(201), short: 'y'.repeat(200), arr: ['x'.repeat(300), 1, { k: 'x'.repeat(300) }],
  },
  tags: { area: 'chat', note: TEXT, count: 3, flag: false },
  contexts: { trace: { trace_id: TRACE_ID, span_id: SPAN_ID, parent_span_id: 'LDL 3.2' }, app: { app_memory: 100, title: 'x' } },
  breadcrumbs: [
    { category: 'console', message: TEXT },
    { category: 'fetch', data: { url: 'https://api.test/files/doc.pdf?x=1', method: 'GET', status_code: 200, body: TEXT } },
    { category: 'xhr', data: { url: 'not a url', method: 1, status_code: '500' } },
    { category: 'http', data: { url: 'https://api.test/x', response_body_size: 9 }, message: TEXT },
    { category: 'fetch' },
    { category: 'navigation', data: { from: '/a/ldl 3.2', to: '/b' }, message: TEXT },
    { category: 'ui.click', message: 'clicked ferritin 12' },
  ],
  request: { url: 'https://shop.test/a/e2 45', headers: { 'X-Custom': 'v' } },
});

describe('A2-6/A3-1 — the server scrub in health-core matches instrument-scrub.mjs', () => {
  it('scrub-vocabulary.ts imports the lab catalogue and nothing else', () => {
    expect(importsOf('./scrub-vocabulary.ts')).toEqual(['./lab-catalog']);
  });

  it('sentry-scrub-server.ts imports only the vocabulary and the shared scrub', () => {
    expect(importsOf('./sentry-scrub-server.ts').sort()).toEqual(['./scrub-vocabulary', './sentry-scrub']);
  });

  it('sentry-scrub.ts still exports what it did before the vocabulary moved', () => {
    expect(Object.keys(browser).sort()).toEqual([
      'EMAIL_SOURCE', 'SCRUB_METRIC_WORDS', 'SCRUB_UNITS', 'SCRUB_UNIT_PATTERN', 'SENSITIVE_EXACT_KEYS',
      'dropLongStrings', 'scrubBreadcrumbData', 'scrubEventText', 'scrubSensitiveData', 'scrubStrings', 'scrubText', 'scrubUrl',
    ]);
  });

  it('an incoming transaction: spans, trace context, links, headers and request', () => {
    const out = both(incomingTransaction) as ReturnType<typeof incomingTransaction>;
    // The outputs are not just equal but scrubbed: the case is not vacuous.
    expect(JSON.stringify(out)).not.toMatch(/3\.2|10\.0\.0\.1|Bearer|lipids|session/);
    expect(out.contexts.trace.trace_id).toBe(TRACE_ID);
    expect(out.contexts.trace.links[0]).toEqual({ trace_id: TRACE_ID, span_id: SPAN_ID, sampled: true });
    expect(out.spans[0].description).toBe('GET https://api.test');
    expect(out.request.headers).toEqual({ Host: 'shop.test', 'User-Agent': 'agent', 'content-type': 'application/json', 'Content-Length': '12', accept: '*/*' });
  });

  it('an outgoing call as its own transaction', () => {
    const out = both(outgoingTransaction) as ReturnType<typeof outgoingTransaction>;
    expect(out.transaction).toBe('POST https://api.test');
    expect(JSON.stringify(out)).not.toMatch(/Jane|doc\.pdf|a@b\.test|3\.2/);
  });

  it('an error with exceptions, breadcrumbs, extra, tags and contexts', () => {
    const out = both(errorEvent) as ReturnType<typeof errorEvent>;
    expect(out.breadcrumbs.map((b) => b.category)).toEqual(['fetch', 'xhr', 'http', 'fetch', 'navigation', 'ui.click']);
    expect(out.exception.values[0].value).toBe('import failed at [value] γ-GT for [email]');
    expect(JSON.stringify(out)).not.toMatch(/3\.2|a@b\.test|x{201}/);
  });

  it('odd shapes at the top: null, undefined, an array, a string, an empty event', () => {
    for (const make of [() => null, () => undefined, () => [], () => [{ extra: { ldl: 3 } }], () => 'event', () => ({})]) both(make);
  });

  it('odd shapes inside: nulls, non-string leaves, arrays where objects go, odd ids', () => {
    const cases: Array<() => unknown> = [
      () => ({ contexts: null, extra: null, request: null, breadcrumbs: null, spans: null }),
      () => ({ contexts: { trace: 'e2 45' }, extra: [TEXT, ['x'.repeat(300)], [[1, [TEXT]]]], tags: [TEXT] }),
      () => ({ contexts: { trace: { data: [TEXT], links: { 0: { trace_id: TRACE_ID } } } } }),
      () => ({ contexts: { trace: { op: 'http.client', data: 'e2 45' } }, transaction: 42 }),
      () => ({ contexts: { trace: { trace_id: TRACE_ID.toUpperCase(), span_id: `${SPAN_ID}0`, parent_span_id: TRACE_ID } } }),
      () => ({ contexts: { trace: { trace_id: [TRACE_ID], span_id: 12345, links: [null, 'e2 45', { span_id: SPAN_ID }] } } }),
      () => ({ spans: [{ op: 'http.client', data: { url: 42, target: '/e2 45', 'http.url': 'ldl://3.2' } }] }),
      () => ({ request: { url: 42, headers: {} }, extra: { n: 1, b: true, z: 0, big: 10n, d: new Date(0), nan: NaN } }),
      () => ({ breadcrumbs: [{ category: 'fetch', data: { url: 42, status_code: { a: 1 } } }] }),
      () => ({ breadcrumbs: [null] }),
      () => ({ exception: { values: null } }),
    ];
    for (const make of cases) both(make);
  });

  it('cyclic objects in extra, contexts, tags and breadcrumb data', () => {
    const cyclic = () => {
      const loop: Record<string, unknown> = { note: TEXT, ldl: 3.2 };
      loop.self = loop;
      return loop;
    };
    for (const field of ['extra', 'contexts', 'tags', 'message']) both(() => ({ [field]: cyclic() }));
    both(() => ({ breadcrumbs: [{ category: 'navigation', data: cyclic() }, { category: 'fetch', data: cyclic() }] }));
  });

  it('every event the existing tests send gives the same output', () => {
    both(() => ({
      message: 'came back 120 lp(a)',
      exception: { values: [{ type: 'Error', value: 'import failed at 33 γ-GT for mailto:a@b.com%2Cc@d.com' }] },
      extra: { to: 'first@example.com+second@example.org', level: '120 lp(a)s' },
    }));
  });
});
