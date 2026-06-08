/**
 * GitHub Pages dev/test surface for Health Roadmap v2 (Phase 0).
 *
 * For now this mounts the storage-spine self-test so Brad (and Claude, via Chrome
 * DevTools) can confirm the merge/sync engine works in a real browser, deployed
 * exactly the way self-hosters will run it. Phase 1 replaces this with the full
 * React HealthTool app — same build target, same Pages URL.
 */
import { CURRENT_SCHEMA_VERSION } from '@roadmap/health-core';
import { runStorageSelfTest, type SelfTestResult } from '../src/storage';
import { initDropboxTest } from './dropbox-test';

const runBtn = document.getElementById('run') as HTMLButtonElement;
const summaryEl = document.getElementById('summary') as HTMLDivElement;
const resultsEl = document.getElementById('results') as HTMLDivElement;
const metaEl = document.getElementById('meta') as HTMLDivElement;

function render(results: SelfTestResult[]): void {
  const passed = results.filter((r) => r.pass).length;
  const all = passed === results.length;
  summaryEl.textContent = `${passed}/${results.length} checks passed`;
  summaryEl.className = `summary ${all ? 'pass' : 'fail'}`;

  resultsEl.innerHTML = '';
  for (const r of results) {
    const row = document.createElement('div');
    row.className = 'result';
    row.innerHTML = `
      <div class="icon ${r.pass ? 'pass' : 'fail'}">${r.pass ? '✓' : '✗'}</div>
      <div>
        <div class="rname">${escapeHtml(r.name)}</div>
        <div class="rdetail">${escapeHtml(r.detail)}</div>
      </div>`;
    resultsEl.appendChild(row);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
}

async function run(): Promise<void> {
  runBtn.disabled = true;
  summaryEl.textContent = 'Running…';
  summaryEl.className = 'summary';
  try {
    const results = await runStorageSelfTest();
    render(results);
    // Expose for DevTools inspection.
    (window as unknown as { __selfTest: SelfTestResult[] }).__selfTest = results;
    const allPass = results.every((r) => r.pass);
    // Machine-readable signal for automated checks.
    document.body.dataset.selfTest = allPass ? 'pass' : 'fail';
    console.info('[health-roadmap] storage self-test:', allPass ? 'PASS' : 'FAIL', results);
  } catch (e) {
    summaryEl.textContent = `Self-test crashed: ${(e as Error).message}`;
    summaryEl.className = 'summary fail';
    document.body.dataset.selfTest = 'crash';
    console.error('[health-roadmap] self-test crashed', e);
  } finally {
    runBtn.disabled = false;
  }
}

const buildHash = (import.meta.env.VITE_GIT_HASH as string | undefined) ?? 'dev';
metaEl.innerHTML = `Schema version <code>${CURRENT_SCHEMA_VERSION}</code> · build <code>${escapeHtml(buildHash)}</code> · this page is the GitHub Pages dev/test surface (front door B).`;

runBtn.addEventListener('click', run);
void run();

// Live Dropbox round-trip (real cloud adapter).
void initDropboxTest({
  status: document.getElementById('dbx-status') as HTMLElement,
  actions: document.getElementById('dbx-actions') as HTMLElement,
  result: document.getElementById('dbx-result') as HTMLElement,
});
