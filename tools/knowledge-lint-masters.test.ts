// US-50 AC7: topic-master lint. Static checks run here over fixtures and over the real docs/blog files
// (inside test:all, never date-dependent). The weekly checks take today's date as an argument and run only
// from tools/knowledge-lint.ts. Extends the US-43 lint; there is no second lint.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  entryFrom, isAllowed, loadInputs, nextState, staticMasterChecks, staticMasterFindings, weeklyMasterFindings,
  writeMasterHashes, type LintState, type MastersConfig,
} from './knowledge-lint';

const SRC = (checked = '2026-10-20') => `[{"name":"NIH ODS","url":"https://ods.od.nih.gov/x","checked":"${checked}","fingerprint":"abc"}]`;
const entry = (handle: string, type: string, front: string[], body = '') =>
  entryFrom({ handle, type, title: handle }, `---\ntitle: "${handle}"\n${front.join('\n')}${front.length ? '\n' : ''}---\n${body}`);
const master = (handle: string, front: string[] = [`reviewed: "2026-10-20"`, `sources: ${SRC()}`], body = '## Current view (reviewed 20 October 2026)\n\nShort [post-a].\n') =>
  entry(handle, 'reference', front, body);
const post = (handle: string, front: string[] = []) => entry(handle, 'video', [`publishedAt: "2026-03-01T00:00:00Z"`, ...front]);
const CFG: MastersConfig = { productIngredients: [], places: [] };
const rules = (fs: { rule: string }[]) => fs.map((f) => f.rule);

describe('US-50 AC7 static: a post naming a missing master', () => {
  it('fails when topics names a handle that does not exist, or one that is not a reference', () => {
    const es = [master('creatine'), post('p1', ['topics: ["creatine","nope","p2"]']), post('p2')];
    const { fails } = staticMasterFindings(es, '', CFG);
    expect(fails.map((f) => `${f.rule}:${f.handle}:${f.item}`).sort()).toEqual(['topic-no-master:p1:nope', 'topic-no-master:p1:p2']);
  });
  it('passes a post whose topics are all references, and a post with no topics', () => {
    const es = [master('creatine'), post('p1', ['topics: ["creatine"]']), post('p2')];
    expect(staticMasterFindings(es, '', CFG).fails).toEqual([]);
  });
});

describe('US-50 AC7 static: a rewritten master needs sources', () => {
  it('fails reviewed with no sources, with unparseable sources, with a missing key, and with a bad date', () => {
    const bad = [
      master('m1', [`reviewed: "2026-10-20"`]),
      master('m2', [`reviewed: "2026-10-20"`, 'sources: [oops']),
      master('m3', [`reviewed: "2026-10-20"`, 'sources: [{"name":"n","url":"u","checked":"2026-10-20"}]']),
      master('m4', [`reviewed: "2026-99-99"`, `sources: ${SRC()}`]),
    ];
    const { fails } = staticMasterFindings(bad, '', CFG);
    expect(fails.map((f) => f.handle).sort()).toEqual(['m1', 'm2', 'm3', 'm4']);
    expect(new Set(rules(fails))).toEqual(new Set(['master-front']));
  });
  it('passes a complete master and exempts an unrewritten reference', () => {
    const es = [master('ok'), entry('old', 'reference', [], '## Dosing\n\n1 g.\n'), entry('art', 'article', [])];
    expect(staticMasterFindings(es, '', CFG).fails).toEqual([]);
  });
});

describe('US-50 AC7 static: hidden post gate (warn only)', () => {
  const hidden = post('p1', ['topics: ["m"]', 'router: hidden']);
  it('warns when the master has no reviewed date or it is older than the post, and never fails', () => {
    const none = staticMasterFindings([entry('m', 'reference', []), hidden], '', CFG);
    expect(rules(none.warns)).toEqual(['master-gate']);
    expect(none.fails).toEqual([]);
    const old = staticMasterFindings([master('m', [`reviewed: "2026-02-28"`, `sources: ${SRC()}`]), hidden], '', CFG);
    expect(rules(old.warns)).toEqual(['master-gate']);
    expect(old.fails).toEqual([]);
  });
  it('is silent when the master is reviewed on or after the post, or the post is not hidden', () => {
    expect(staticMasterFindings([master('m', [`reviewed: "2026-03-01"`, `sources: ${SRC()}`]), hidden], '', CFG).warns).toEqual([]);
    expect(staticMasterFindings([entry('m', 'reference', []), post('p2', ['topics: ["m"]'])], '', CFG).warns).toEqual([]);
  });
});

describe('US-50 AC7 static: current-view DOI in products.md (warn only)', () => {
  const cfg: MastersConfig = { productIngredients: ['m'], places: [] };
  const body = '## Current view (reviewed 20 October 2026)\n\nSee doi 10.1000/abc.123 and a trial [1].\n\n## References\n\n[1] Smith. https://doi.org/10.1000/DEF456\n';
  it('warns for each DOI missing from products.md, including one reached through a cited reference line', () => {
    const r = staticMasterFindings([master('m', undefined, body)], 'Only 10.1000/abc.123 here.', cfg);
    expect(r.warns.map((w) => `${w.rule}:${w.item}`)).toEqual(['master-doi:10.1000/def456']);
    expect(r.fails).toEqual([]);
  });
  it('is silent when products.md has them all, or the master is not a product ingredient', () => {
    expect(staticMasterFindings([master('m', undefined, body)], '10.1000/abc.123 10.1000/DEF456', cfg).warns).toEqual([]);
    expect(staticMasterFindings([master('m', undefined, body)], '', CFG).warns).toEqual([]);
  });
});

describe('US-50 AC7 static: the real docs/blog files', () => {
  it('has no failure today, and prints the warnings', () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const { fails, warns } = staticMasterChecks(repo);
    for (const w of warns) console.warn(`WARN ${w.rule} ${w.handle}: ${w.item}${w.detail ? ` (${w.detail})` : ''}`);
    expect(fails).toEqual([]);
  });
});

describe('US-50 AC7 weekly checks (date-dependent, never in test:all)', () => {
  const none = () => null;
  it('flags a master reviewed before its newest linked post', () => {
    const es = [master('m', [`reviewed: "2026-02-01"`, `sources: ${SRC('2026-02-01')}`]), post('p1', ['topics: ["m"]']), post('p0', ['topics: ["m"]'])];
    const f = weeklyMasterFindings(es, '2026-02-02', null, CFG, none).filter((x) => x.rule === 'master-stale');
    expect(f.map((x) => `${x.handle}:${x.item}`)).toEqual(['m:p1']);
  });
  it('does not flag a master reviewed on the post date', () => {
    const es = [master('m', [`reviewed: "2026-03-01"`, `sources: ${SRC('2026-03-01')}`]), post('p1', ['topics: ["m"]'])];
    expect(weeklyMasterFindings(es, '2026-03-02', null, CFG, none)).toEqual([]);
  });
  it('flags a source checked more than 35 days ago, not 35', () => {
    const es = [master('m', [`reviewed: "2026-10-20"`, `sources: ${SRC('2026-09-15')}`])];
    expect(weeklyMasterFindings(es, '2026-10-20', null, CFG, none)).toEqual([]);
    expect(rules(weeklyMasterFindings(es, '2026-10-21', null, CFG, none))).toEqual(['source-stale']);
  });

  describe('current view changed, a registered place did not', () => {
    const view = (t: string) => `## Current view (reviewed 20 October 2026)\n\n${t} [post-a].\n\n## Dosing\n\nx\n`;
    const cfg: MastersConfig = { productIngredients: [], places: [{ topic: 'm', file: 'docs/products.md', snippet: 'Creatine 5 g' }] };
    const file = (extra: string) => () => `Intro.\n\n${extra}Creatine 5 g daily in the blend.\n\nOutro.\n`;
    it('flags the unchanged place; line numbers do not matter, text anchors do', () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      writeMasterHashes(o, '2026-10-20', [master('m', undefined, view('One'))], cfg);
      const s = JSON.parse(readFileSync(join(o, 'docs/loops/chat-health/lint-state.json'), 'utf8')) as LintState;
      expect(Object.keys(s.masters!)).toEqual(['m']);
      const changedView = [master('m', undefined, view('Two'))];
      const read = (rel: string) => readFileSync(join(o, rel), 'utf8');
      const f = weeklyMasterFindings(changedView, '2026-10-27', s, cfg, read);
      expect(f.map((x) => `${x.rule}:${x.handle}:${x.item}`)).toEqual(['master-places:m:docs/products.md: Creatine 5 g']);
      // Lines added above the anchor move it but do not count as a change.
      writeFileSync(join(o, 'docs/products.md'), file('New line one.\n\nNew paragraph.\n\n')());
      expect(weeklyMasterFindings(changedView, '2026-10-27', s, cfg, read).map((x) => x.rule)).toEqual(['master-places']);
      // Editing the anchored paragraph counts as a change: no finding.
      writeFileSync(join(o, 'docs/products.md'), 'Creatine 5 g daily, now 6 g in some.\n');
      expect(weeklyMasterFindings(changedView, '2026-10-27', s, cfg, read)).toEqual([]);
    });
    it('is silent when the view is unchanged, when there is no stored hash yet, and when no place is registered', () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      writeMasterHashes(o, '2026-10-20', [master('m', undefined, view('One'))], cfg);
      const s = JSON.parse(readFileSync(join(o, 'docs/loops/chat-health/lint-state.json'), 'utf8')) as LintState;
      const read = (rel: string) => readFileSync(join(o, rel), 'utf8');
      expect(weeklyMasterFindings([master('m', undefined, view('One'))], '2026-10-27', s, cfg, read)).toEqual([]);
      expect(weeklyMasterFindings([master('m', undefined, view('Two'))], '2026-10-27', { ...s, masters: undefined }, cfg, read)).toEqual([]);
      expect(weeklyMasterFindings([master('m', undefined, view('Two'))], '2026-10-27', s, CFG, read)).toEqual([]);
    });
    it('reports a place whose anchor text is gone', () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      writeMasterHashes(o, '2026-10-20', [master('m', undefined, view('One'))], cfg);
      const s = JSON.parse(readFileSync(join(o, 'docs/loops/chat-health/lint-state.json'), 'utf8')) as LintState;
      writeFileSync(join(o, 'docs/products.md'), 'Reworded entirely.\n');
      const f = weeklyMasterFindings([master('m', undefined, view('One'))], '2026-10-27', s, cfg, (rel) => readFileSync(join(o, rel), 'utf8'));
      expect(f.map((x) => x.detail ?? '').join()).toContain('anchor text not found');
    });
    it('is waived by an allow-list entry with who and date, matched on the place', () => {
      const f = { rule: 'master-places' as const, handle: 'm', item: 'docs/products.md: Creatine 5 g' };
      const entry1 = { rule: 'master-places', handle: 'm', item: f.item, reason: 'Dose unchanged on purpose', date: '2026-10-27', who: 'Brad' };
      expect(isAllowed(f, [entry1])).toBe(true);
      expect(isAllowed({ ...f, item: 'other' }, [entry1])).toBe(false);
    });
    it('writeMasterHashes keeps every other state key, and a later run of nextState keeps the masters section', () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      const before = JSON.parse(readFileSync(join(o, 'docs/loops/chat-health/lint-state.json'), 'utf8')) as LintState;
      const r = writeMasterHashes(o, '2026-10-20', [master('m', undefined, view('One'))], cfg);
      expect(r.written).toBe(1);
      const after = JSON.parse(readFileSync(join(o, 'docs/loops/chat-health/lint-state.json'), 'utf8')) as LintState;
      expect({ ...after, masters: undefined }).toEqual({ ...before, masters: undefined });
      expect(after.masters!.m.at).toBe('2026-10-20');
      expect(nextState([], after, [], '', '2026-11-01', true).masters).toEqual(after.masters);
    });
  });
});

describe('US-50 AC7 lint-topics.json masters section', () => {
  it('the real loadInputs returns an empty masters config today', () => {
    const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const m = loadInputs(repo).masters;
    expect(Array.isArray(m.productIngredients)).toBe(true);
    expect(Array.isArray(m.places)).toBe(true);
  });
  it('rejects an unknown handle, an absolute file and a path that leaves the repo', () => {
    const o = mkRoot({}, { masters: { productIngredients: ['nope'], places: [] } });
    expect(() => loadInputs(o)).toThrow(/nope/);
    const o2 = mkRoot({}, { masters: { productIngredients: [], places: [{ topic: 'm', file: '../x', snippet: 's' }] } });
    expect(() => loadInputs(o2)).toThrow(/file/);
    vi.restoreAllMocks();
  });
});

/** A scratch repo: one index entry "m" (a reference), a blank lint-state.json, and the given files. */
function mkRoot(files: Record<string, string>, topics: object = {}): string {
  const o = mkdtempSync(join(tmpdir(), 'kl-masters-'));
  const put = (rel: string, text: string) => { mkdirSync(dirname(join(o, rel)), { recursive: true }); writeFileSync(join(o, rel), text); };
  put('docs/blog/index.json', JSON.stringify([{ handle: 'm', type: 'reference', title: 'm', summary: '', keywords: [] }]));
  put('docs/blog/m.md', '---\ntitle: "m"\n---\nBody\n');
  put('docs/loops/chat-health/lint-topics.json', JSON.stringify({ topics: [], nouns: {}, ...topics }));
  put('docs/loops/chat-health/lint-state.json', JSON.stringify({ version: 1, lastRun: '2026-10-04T00:00:00.000Z', cursor: 3, pairs: {}, algorithm: {}, entries: {} }));
  for (const [rel, text] of Object.entries(files)) put(rel, text);
  return o;
}
