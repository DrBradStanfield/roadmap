/**
 * tools/flake-watch.mjs (US-64 AC36): given a workflow run, list the jobs whose latest attempt passed after an
 * earlier attempt failed, and name the test files that failed in that attempt. On 2026-11-21 run 44860674548
 * went red on `unit (2, UTC)` (tools/split-stories.test.ts, a git lock racing a copy), passed on a rerun,
 * and nothing recorded it. The fixtures are that run's real attempts, annotations and log, trimmed.
 */
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { flakyJobs, filesFromAnnotations, filesFromLog, watch, formatMarkdown, main, createApi, FETCH_TIMEOUT_MS } from './flake-watch.mjs';

const FX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures/flake-watch');
const fx = (name: string) => readFileSync(join(FX, name), 'utf8');
const json = (name: string) => JSON.parse(fx(name));
const RUN = 44860674548;
const FAILED_JOB = 136713072392;

/** A fake API: path -> value; a missing path throws, as a 404 or 403 would. */
const fakeApi = (routes: Record<string, unknown>) => ({
  json: async (p: string) => { if (!(p in routes)) throw new Error(`HTTP 404 ${p}`); return routes[p]; },
  text: async (p: string) => { if (!(p in routes)) throw new Error(`HTTP 403 ${p}`); return routes[p] as string; },
});
const baseRoutes = () => ({
  [`actions/runs/${RUN}`]: { id: RUN, run_attempt: 2, html_url: `https://github.com/o/r/actions/runs/${RUN}`, head_sha: 'd983de63f5fd7bf1447019900f77659d0c7b2cbc' },
  [`actions/runs/${RUN}/attempts/1/jobs?per_page=100`]: json('attempt-1-jobs.json'),
  [`actions/runs/${RUN}/attempts/2/jobs?per_page=100`]: json('attempt-2-jobs.json'),
});

describe('flakyJobs (US-64 AC36)', () => {
  it('names each job that failed on an earlier attempt and passed on its latest, never the `test` gate that only follows them', () => {
    const got = flakyJobs([json('attempt-1-jobs.json').jobs, json('attempt-2-jobs.json').jobs]);
    expect(got).toEqual([
      { name: 'unit (2, UTC)', failedAttempt: 1, failedJobId: FAILED_JOB, conclusion: 'failure' },
    ]);
  });

  it('a job still failing on its latest attempt is not a flake, nor is one that was only cancelled', () => {
    const a1 = [{ id: 1, name: 'a', conclusion: 'failure' }, { id: 2, name: 'b', conclusion: 'cancelled' }];
    const a2 = [{ id: 3, name: 'a', conclusion: 'failure' }, { id: 4, name: 'b', conclusion: 'success' }];
    expect(flakyJobs([a1, a2])).toEqual([]);
  });

  it('a timed-out attempt counts, and a job missing from a later attempt keeps its last result', () => {
    const a1 = [{ id: 1, name: 'a', conclusion: 'timed_out' }, { id: 2, name: 'b', conclusion: 'failure' }];
    const a2 = [{ id: 3, name: 'a', conclusion: 'success' }];
    expect(flakyJobs([a1, a2])).toEqual([{ name: 'a', failedAttempt: 1, failedJobId: 1, conclusion: 'timed_out' }]);
  });
});

describe('failed test files', () => {
  it('come from the failed attempt\'s failure annotations, test files only', () => {
    expect(filesFromAnnotations(json('annotations-136713072392.json'))).toEqual(['tools/split-stories.test.ts']);
  });

  it('come from the log\'s FAIL lines, colour codes stripped, when there are no annotations', () => {
    expect(filesFromLog(fx('fail-log.txt'))).toEqual(['tools/split-stories.test.ts']);
  });

  it('a log line that is not a plain path names nothing', () => {
    expect(filesFromLog('2026Z  FAIL  $(touch x).test.ts > y\n2026Z  FAIL  a b.test.ts')).toEqual([]);
  });
});

describe('watch', () => {
  it('reports the flaky jobs with the files that failed', async () => {
    const api = fakeApi({ ...baseRoutes(), [`check-runs/${FAILED_JOB}/annotations`]: json('annotations-136713072392.json'), 'check-runs/136713695509/annotations': [] });
    const got = await watch(RUN, api);
    expect(got.attempt).toBe(2);
    const unit = got.flaky.find((f: { name: string }) => f.name === 'unit (2, UTC)');
    expect(unit).toMatchObject({ failedAttempt: 1, files: ['tools/split-stories.test.ts'], source: 'annotations' });
  });

  it('falls back to the log (a local gh token can read it), and says so when neither can be read (CI)', async () => {
    const withLog = await watch(RUN, fakeApi({ ...baseRoutes(), [`actions/jobs/${FAILED_JOB}/logs`]: fx('fail-log.txt') }));
    expect(withLog.flaky).toEqual([expect.objectContaining({ name: 'unit (2, UTC)', files: ['tools/split-stories.test.ts'], source: 'log' })]);
    const none = await watch(RUN, fakeApi(baseRoutes()));
    expect(none.flaky).toEqual([expect.objectContaining({ name: 'unit (2, UTC)', files: [], source: 'none' })]);
  });

  it('a first attempt has nothing to report and reads no jobs', async () => {
    const api = fakeApi({ [`actions/runs/${RUN}`]: { id: RUN, run_attempt: 1 } });
    expect(await watch(RUN, api)).toMatchObject({ attempt: 1, flaky: [] });
  });
});

describe('createApi: a hung request cannot hold the job (owner ruling R1)', () => {
  it('gives every request a 20 s abort signal, and a hung one rejects', async () => {
    expect(FETCH_TIMEOUT_MS).toBe(20_000);
    const signals: AbortSignal[] = [];
    const hang = (_url: string, init: { signal: AbortSignal }) => {
      signals.push(init.signal);
      return new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)));
    };
    const api = createApi('o/r', { GH_TOKEN: 'test-token-good' }, hang as unknown as typeof fetch, 30);
    await expect(api.json('actions/runs/1')).rejects.toThrow();
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((s) => s instanceof AbortSignal)).toBe(true);
  });

  it('retries a 403 without the token, with a signal on both requests', async () => {
    const calls: { auth: boolean; signal: unknown }[] = [];
    const f = async (_url: string, init: { headers: Record<string, string>; signal: unknown }) => {
      calls.push({ auth: 'authorization' in init.headers, signal: init.signal });
      return calls.length === 1 ? new Response('', { status: 403 }) : new Response('{"ok":1}', { status: 200 });
    };
    expect(await createApi('o/r', { GH_TOKEN: 'test-token-good' }, f as unknown as typeof fetch).json('x')).toEqual({ ok: 1 });
    expect(calls.map((c) => c.auth)).toEqual([true, false]);
    expect(calls.every((c) => c.signal instanceof AbortSignal)).toBe(true);
  });
});

describe('formatMarkdown and main (the CI step)', () => {
  it('writes the record to the job summary and one warning per flaky job, exit 0', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flake-'));
    const summary = join(dir, 'summary.md');
    const routes = { ...baseRoutes(), [`check-runs/${FAILED_JOB}/annotations`]: json('annotations-136713072392.json') };
    const out: string[] = [];
    const code = await main([String(RUN)], { GITHUB_STEP_SUMMARY: summary }, (s: string) => out.push(s), fakeApi(routes));
    expect(code).toBe(0);
    const md = readFileSync(summary, 'utf8');
    expect(md).toContain('### Flake watch: run 44860674548, attempt 2');
    expect(md).toContain('| `unit (2, UTC)` | 1 | failure | `tools/split-stories.test.ts` |');
    const warnings = out.filter((l) => l.startsWith('::warning '));
    expect(warnings).toEqual(['::warning title=Flaky CI job::unit (2, UTC) failed on attempt 1, passed on attempt 2: tools/split-stories.test.ts']);
  });

  it('a job with no file evidence is reported plainly, not as a flaky test', async () => {
    const out: string[] = [];
    await main([String(RUN)], {}, (s: string) => out.push(s), fakeApi(baseRoutes()));
    const text = out.join('\n');
    expect(text).toContain('| `unit (2, UTC)` | 1 | failure | no test file found |');
    expect(text).toContain('::warning title=Flaky CI job::unit (2, UTC) failed on attempt 1, passed on attempt 2; a job failed then passed, no test file found');
    expect(text).not.toMatch(/flaky test to fix/);
  });

  it('says plainly when the run passed first time', () => {
    expect(formatMarkdown({ runId: 7, attempt: 1, flaky: [] })).toContain('No job failed before it passed');
  });

  it('refuses a run id that is not a number (exit 2) and never fails CI on an API error (exit 0)', async () => {
    const out: string[] = [];
    expect(await main(['12; rm -rf /'], {}, (s: string) => out.push(s), fakeApi({}))).toBe(2);
    expect(await main(['99'], {}, (s: string) => out.push(s), fakeApi({}))).toBe(0);
    expect(out.join('\n')).toContain('could not read run 99');
  });
});
