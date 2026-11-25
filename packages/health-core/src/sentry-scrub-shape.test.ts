/**
 * The shape of the scrub source that instrument-scrub.mjs is generated from (US-09 AC7, AC7j; audit A2-6/A3-1).
 * Kept from the retired sentry-scrub-server-parity.test.ts: its output-parity comparison is now the generator's
 * freshness test (tools/generate-instrument-scrub.test.ts), but these checks are made nowhere else.
 * The vocabulary's one direct import is the place the generator swaps for literal lists, so the generated server
 * file carries none of the catalogue's graph.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { scrubServerEvent } from './sentry-scrub-server';
import * as browser from './sentry-scrub';

/** Every module a source file imports, static, re-exported or dynamic. */
const importsOf = (file: string): string[] => {
  const src = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...src.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)].map((m) => m[1]);
};

describe('US-09 AC7, A2-6/A3-1: the server scrub source keeps its shape', () => {
  it('scrub-vocabulary.ts directly imports ./lab-catalog and nothing else', () => {
    expect(importsOf('./scrub-vocabulary.ts')).toEqual(['./lab-catalog']);
  });

  it('sentry-scrub-server.ts directly imports only the vocabulary and the shared scrub', () => {
    expect(importsOf('./sentry-scrub-server.ts').sort()).toEqual(['./scrub-vocabulary', './sentry-scrub']);
  });

  it('sentry-scrub.ts still exports what it did before the vocabulary moved', () => {
    expect(Object.keys(browser).sort()).toEqual([
      'EMAIL_SOURCE', 'SCRUB_METRIC_WORDS', 'SCRUB_UNITS', 'SCRUB_UNIT_PATTERN', 'SENSITIVE_EXACT_KEYS',
      // firstScrubbedValue: the feedback guard reads the scrub through it (US-32 AC9b).
      'dropLongStrings', 'firstScrubbedValue', 'scrubBreadcrumbData', 'scrubEventText', 'scrubSensitiveData', 'scrubStrings', 'scrubText', 'scrubUrl',
    ]);
  });

  it('a request keeps exactly the allow-listed headers', () => {
    const out = scrubServerEvent({
      type: 'transaction',
      request: {
        url: 'https://shop.test/apps/roadmap', method: 'POST',
        headers: { Host: 'shop.test', 'User-Agent': 'agent', Cookie: 's=1', Authorization: 'Bearer t', Referer: 'https://shop.test/?q=1',
          'content-type': 'application/json', 'Content-Length': '12', accept: '*/*', 'x-forwarded-for': '10.0.0.1' },
      },
    }) as { request: { headers: Record<string, string> } };
    expect(out.request.headers).toEqual({ Host: 'shop.test', 'User-Agent': 'agent', 'content-type': 'application/json', 'Content-Length': '12', accept: '*/*' });
  });
});
