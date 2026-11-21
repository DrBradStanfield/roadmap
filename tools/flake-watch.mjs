#!/usr/bin/env node
/**
 * Flake watch (US-64 AC36): `node tools/flake-watch.mjs <run id> [--repo owner/name]` lists the jobs of a
 * workflow run whose latest attempt passed after an earlier attempt failed or timed out, and names the test
 * files that failed in that attempt: from its failure annotations (public data), else from its log's FAIL
 * lines (the log needs a token). It prints a Markdown record, appends it to GITHUB_STEP_SUMMARY when set, and
 * writes one GitHub warning per flaky job. Exit 0 always, even when the API cannot be read; 2 on a bad run id.
 * Job names, annotations and logs are data: file names pass only as plain paths, and output is escaped.
 * Token: GH_TOKEN or GITHUB_TOKEN, else `gh auth token`; a 401 or 403 retries without one (public repo).
 * How to read the output: docs/git-workflow.md § Test time and flake watch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const FAILED = new Set(['failure', 'timed_out']);
const TEST_FILE = /^[\w@./-]+\.(test|spec)\.[cm]?[jt]sx?$/;

/** attempts[i] is attempt i+1's job list. A job's latest result is its last appearance. */
export function flakyJobs(attempts) {
  const byName = new Map();
  attempts.forEach((jobs, i) => {
    for (const j of jobs ?? []) {
      const e = byName.get(j.name) ?? { firstFail: null };
      if (FAILED.has(j.conclusion) && !e.firstFail) e.firstFail = { attempt: i + 1, id: j.id, conclusion: j.conclusion };
      e.latest = j.conclusion;
      byName.set(j.name, e);
    }
  });
  return [...byName]
    .filter(([, e]) => e.latest === 'success' && e.firstFail)
    .map(([name, e]) => ({ name, failedAttempt: e.firstFail.attempt, failedJobId: e.firstFail.id, conclusion: e.firstFail.conclusion }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

const unique = (xs) => [...new Set(xs)];

export const filesFromAnnotations = (annotations) =>
  unique((annotations ?? []).filter((a) => a.annotation_level === 'failure' && TEST_FILE.test(a.path ?? '')).map((a) => a.path));

export function filesFromLog(text) {
  const files = [];
  for (const line of String(text).replace(/\x1b\[[0-9;]*m/g, '').split('\n')) {
    const m = /\sFAIL\s+(\S+)(\s|$)/.exec(line);
    if (m && TEST_FILE.test(m[1])) files.push(m[1]);
  }
  return unique(files);
}

export async function watch(runId, api) {
  const run = await api.json(`actions/runs/${runId}`);
  const attempt = Number(run.run_attempt) || 1;
  const result = { runId, attempt, url: run.html_url, sha: run.head_sha, flaky: [] };
  if (attempt < 2) return result;
  const attempts = [];
  for (let n = 1; n <= attempt; n++) attempts.push((await api.json(`actions/runs/${runId}/attempts/${n}/jobs?per_page=100`)).jobs);
  for (const job of flakyJobs(attempts)) {
    let files = [];
    let source = 'none';
    try { files = filesFromAnnotations(await api.json(`check-runs/${job.failedJobId}/annotations`)); } catch { /* none */ }
    if (files.length) source = 'annotations';
    else {
      try { files = filesFromLog(await api.text(`actions/jobs/${job.failedJobId}/logs`)); } catch { /* none */ }
      if (files.length) source = 'log';
    }
    result.flaky.push({ ...job, files, source });
  }
  return result;
}

// A job name is ours (ci.yml), but escape it like any other text before it reaches Markdown or the log.
const md = (s) => String(s).replace(/[`|\r\n]/g, ' ');
const escData = (s) => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');

export function formatMarkdown(r) {
  const head = `### Flake watch: run ${r.runId}, attempt ${r.attempt}${r.sha ? ` (${r.sha.slice(0, 12)})` : ''}\n\n`;
  if (!r.flaky.length) return `${head}No job failed before it passed on this run.\n`;
  const rows = r.flaky.map((f) =>
    `| \`${md(f.name)}\` | ${f.failedAttempt} | ${f.conclusion} | ${f.files.length ? f.files.map((x) => `\`${x}\``).join(', ') : `not found (${f.source})`} |`);
  return `${head}These jobs failed, then passed on a rerun. Each is a flaky test to fix, not a pass.\n\n` +
    `| Job | Failed attempt | Result | Failed test files |\n|---|---|---|---|\n${rows.join('\n')}\n`;
}

export function createApi(repo, env = process.env) {
  let token = env.GH_TOKEN || env.GITHUB_TOKEN;
  if (!token) { try { token = execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* anonymous */ } }
  const get = async (p) => {
    const url = `https://api.github.com/repos/${repo}/${p}`;
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'flake-watch' };
    let res = token ? await fetch(url, { headers: { ...headers, authorization: `Bearer ${token}` } }) : null;
    if (!res || res.status === 401 || res.status === 403) res = await fetch(url, { headers });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${p}`);
    return res;
  };
  return { json: async (p) => (await get(p)).json(), text: async (p) => (await get(p)).text() };
}

export async function main(argv, env = process.env, log = console.log, api = null) {
  const runId = argv[0];
  if (!/^\d+$/.test(runId ?? '')) { log('usage: node tools/flake-watch.mjs <run id> [--repo owner/name]'); return 2; }
  const i = argv.indexOf('--repo');
  const repo = i > 0 ? argv[i + 1] : env.GITHUB_REPOSITORY;
  let r;
  try { r = await watch(runId, api ?? createApi(repo, env)); } catch (e) {
    log(`Flake watch could not read run ${runId}: ${e.message}`);
    return 0;
  }
  const text = formatMarkdown(r);
  log(text);
  for (const f of r.flaky) {
    log(`::warning title=Flaky CI job::${escData(`${f.name} failed on attempt ${f.failedAttempt}, passed on attempt ${r.attempt}: ${f.files.join(', ') || 'failed test files not found'}`)}`);
  }
  if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, `${text}\n`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
