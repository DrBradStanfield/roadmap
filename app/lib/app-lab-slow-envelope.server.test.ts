import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as Sentry from '@sentry/react-router';

// US-52 AC7d: exactly what leaves the server for one slow phone import, envelope
// header included, so the app privacy notice is checked against fact. Real SDK,
// production's init options (instrument.server.mjs), a capturing transport.
//
// Release: init sets none, so the SDK reads SENTRY_RELEASE (or a CI variable such
// as GITHUB_SHA) from the runtime env. Production passes SENTRY_RELEASE only as a
// Docker build arg scoped to the build step (Dockerfile, deploy.yml), so the server
// runs without one: these tests clear those variables, as production's runtime has them.

const mocks = vi.hoisted(() => ({ clock: { now: 1_800_000_000_000 } }));
vi.mock('@sentry/react-router', async (original) => ({
  ...await original<typeof import('@sentry/react-router')>(), init: vi.fn(),
}));
vi.mock('../shopify.server', () => ({ authenticate: { public: { appProxy: vi.fn() } } }));
vi.mock('./app-gate.server', async (original) => ({
  ...await original<typeof import('./app-gate.server')>(),
  appRoutesOff: () => false,
  appGate: async (request: Request) => ({ body: Buffer.from(await request.arrayBuffer()) }),
}));
vi.mock('./anthropic.server', async (original) => ({
  ...await original<typeof import('./anthropic.server')>(),
  // A 70 s read after the capacity retry: slow-success, 60-75, retry yes.
  extractOrClassify: async (_pages: unknown, opts: { onRetry?: () => void }) => {
    opts.onRetry?.();
    mocks.clock.now += 70_000;
    return {
      classification: 'lab_report', reportDate: '2026-10-01', unrecognized: [], document: null,
      values: [{ metric: 'ldl', valueSI: 3.1, displayValue: 3.1, displayUnit: 'mmol/L', displaySystem: 'si', confidence: 'high' }],
      additionalValues: [], refusedValues: [],
    };
  },
}));

import { appLabImport } from './app-routes.server';

// Every variable getSentryRelease reads at init (node-core sdk/api.js), cleared as in production.
const RELEASE_ENV = [
  'SENTRY_RELEASE', 'GITHUB_SHA', 'CI_MERGE_REQUEST_SOURCE_BRANCH_SHA', 'CI_BUILD_REF', 'CI_COMMIT_SHA', 'BITBUCKET_COMMIT',
  'APPVEYOR_PULL_REQUEST_HEAD_COMMIT', 'APPVEYOR_REPO_COMMIT', 'CODEBUILD_RESOLVED_SOURCE_VERSION', 'AWS_COMMIT_ID',
  'BUILD_SOURCEVERSION', 'GIT_CLONE_COMMIT_HASH', 'BUDDY_EXECUTION_REVISION', 'BUILDKITE_COMMIT', 'CIRCLE_SHA1',
  'CIRRUS_CHANGE_IN_REPO', 'CF_REVISION', 'CM_COMMIT', 'CF_PAGES_COMMIT_SHA', 'DRONE_COMMIT_SHA', 'FC_GIT_COMMIT_SHA',
  'HEROKU_TEST_RUN_COMMIT_VERSION', 'HEROKU_BUILD_COMMIT', 'HEROKU_SLUG_COMMIT', 'SEMAPHORE_GIT_SHA', 'TRAVIS_PULL_REQUEST_SHA',
  'TRAVIS_COMMIT', 'VERCEL_GIT_COMMIT_SHA', 'VERCEL_GITHUB_COMMIT_SHA', 'VERCEL_GITLAB_COMMIT_SHA', 'VERCEL_BITBUCKET_COMMIT_SHA',
  'ZEIT_GITHUB_COMMIT_SHA', 'ZEIT_GITLAB_COMMIT_SHA', 'ZEIT_BITBUCKET_COMMIT_SHA', 'CI_COMMIT_ID', 'SOURCE_COMMIT',
  'SOURCE_VERSION', 'GIT_COMMIT', 'COMMIT_REF', 'BUILD_VCS_NUMBER',
];
const saved = Object.fromEntries(RELEASE_ENV.map((k) => [k, process.env[k]]));

type Envelope = [Record<string, any>, Array<[{ type: string }, Record<string, any>]>];
const envelopes: Envelope[] = [];

async function initWith(env: Record<string, string>) {
  for (const k of RELEASE_ENV) delete process.env[k];
  Object.assign(process.env, env);
  vi.mocked(Sentry.init).mockClear();
  vi.resetModules();
  await import('../../instrument.server.mjs');
  const options = vi.mocked(Sentry.init).mock.calls[0][0]!;
  const { init } = await vi.importActual<typeof import('@sentry/react-router')>('@sentry/react-router');
  init({
    ...options,
    dsn: 'https://public@example.invalid/1',
    enabled: true,
    transport: () => ({
      send: async (envelope: unknown) => { envelopes.push(envelope as unknown as Envelope); return { statusCode: 200 }; },
      flush: async () => true,
    }),
  });
}

/** One slow-success phone import; returns the slow-import envelope's header and event. */
async function slowImport() {
  await Sentry.flush(2000);
  envelopes.length = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => mocks.clock.now);
  process.env.ANTHROPIC_API_KEY = 'test-key-dummy';
  const body = { pages: [{ type: 'text', content: 'LDL 3.1 mmol/L' }], unitSystem: 'si', ownDates: true, refusedRows: true };
  const res = await appLabImport(new Request('https://example.invalid/api/app/v1/lab-import', { method: 'POST', body: JSON.stringify(body) }));
  expect(res.status).toBe(200);
  await Sentry.flush(2000);
  vi.restoreAllMocks();
  // Read as the wire carries it: serialized, so keys holding undefined are gone.
  const sent = envelopes.map((e) => JSON.parse(JSON.stringify(e)) as Envelope);
  const [eventEnvelope, ...more] = sent.filter(([, items]) => items.some(([h]) => h.type === 'event'));
  expect(more).toEqual([]);
  const [header, items] = eventEnvelope;
  expect(items.map(([h]) => h.type)).toEqual(['event']);
  return {
    header, event: items[0][1], raw: JSON.stringify(sent),
    // Item types of every envelope sent, the event's included.
    types: sent.map(([, its]) => its.map(([h]) => h.type).join('+')),
    sessions: sent.flatMap(([, its]) => its.filter(([h]) => h.type === 'session').map(([, p]) => p)),
  };
}

beforeAll(() => initWith({}));
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
});

const HEX32 = /^[0-9a-f]{32}$/;
const HEX16 = /^[0-9a-f]{16}$/;

describe('US-52 AC7d: the slow-import envelope, header and body, field by field', () => {
  it('US-52 AC7d: the event body holds exactly ten keys and the four fixed tags', async () => {
    const { event } = await slowImport();
    expect(Object.keys(event).sort()).toEqual(
      ['contexts', 'environment', 'event_id', 'fingerprint', 'level', 'message', 'platform', 'sdk', 'tags', 'timestamp'],
    );
    expect(event.event_id).toMatch(HEX32);
    expect(event.timestamp).toBe(mocks.clock.now / 1000);
    expect(event.level).toBe('warning');
    expect(event.message).toBe('App lab import slow');
    expect(event.fingerprint).toEqual(['app-lab-import', 'slow-success']);
    expect(event.platform).toBe('node');
    expect(event.environment).toBe('production');
    expect(event.tags).toEqual({ feature: 'app-lab-import', outcome: 'slow-success', duration: '60-75', retry: 'yes' });
    // A fresh trace's ids only: no op, origin, status or data.
    expect(Object.keys(event.contexts)).toEqual(['trace']);
    expect(Object.keys(event.contexts.trace).sort()).toEqual(['parent_span_id', 'span_id', 'trace_id']);
    expect(event.contexts.trace.trace_id).toMatch(HEX32);
    expect(event.contexts.trace.span_id).toMatch(HEX16);
    expect(event.contexts.trace.parent_span_id).toMatch(HEX16);
  });

  it('US-52 AC7d: the body\'s sdk names the SDK, its version, its integrations and its packages', async () => {
    const { event } = await slowImport();
    const { sdk } = event;
    expect(Object.keys(sdk).sort()).toEqual(['integrations', 'name', 'packages', 'version']);
    expect(sdk.name).toBe('sentry.javascript.react-router');
    expect(sdk.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sdk.packages).toEqual([
      { name: 'npm:@sentry/react-router', version: sdk.version },
      { name: 'npm:@sentry/node', version: sdk.version },
    ]);
    // Integration names only (SDK feature names, not app data); the Console one is off in production.
    expect(sdk.integrations.length).toBeGreaterThan(0);
    for (const name of sdk.integrations) expect(name).toMatch(/^[A-Za-z0-9_]+$/);
    expect(sdk.integrations).toContain('Http');
    expect(sdk.integrations).not.toContain('Console');
  });

  it('US-52 AC7d: the envelope header holds event_id, sent_at, sdk and a three-key trace context', async () => {
    const { header, event } = await slowImport();
    expect(Object.keys(header).sort()).toEqual(['event_id', 'sdk', 'sent_at', 'trace']);
    expect(header.event_id).toBe(event.event_id);
    expect(header.sent_at).toBe(new Date(mocks.clock.now).toISOString());
    // No dsn: the SDK adds it only when a tunnel is set.
    expect(header.sdk).toEqual({ name: 'sentry.javascript.react-router', version: event.sdk.version });
    // Dynamic sampling context: no release, transaction, sample rate or sampled flag.
    expect(header.trace).toEqual({ environment: 'production', public_key: 'public', trace_id: event.contexts.trace.trace_id });
  });

  it('US-52 AC7d: with production\'s runtime env, no release travels, in the header or the body', async () => {
    // If this fails, docs/privacy-app-addendum.md must change in the same PR as the change that made it fail.
    const { header, event, raw, types } = await slowImport();
    // One envelope, the event: no session envelope, which the SDK sends only with a release.
    expect(types).toEqual(['event']);
    expect(header.trace.release).toBeUndefined();
    expect(event.release).toBeUndefined();
    expect(raw).not.toContain('release');
  });

  it('US-52 AC7d: the control: a runtime SENTRY_RELEASE would travel in the header\'s trace context and a session envelope, not the body', async () => {
    await initWith({ SENTRY_RELEASE: 'health-tool-app@0000000' });
    try {
      const { header, event, types, sessions } = await slowImport();
      expect(header.trace.release).toBe('health-tool-app@0000000');
      // The body's allow-list drops it.
      expect(event.release).toBeUndefined();
      // With a release the SDK also sends its process session, whose attrs name it.
      expect(types).toEqual(['session', 'event']);
      expect(sessions[0].attrs).toEqual({ release: 'health-tool-app@0000000', environment: 'production', user_agent: expect.stringMatching(/^Node\.js\//) });
    } finally {
      await initWith({});
    }
  });
});
