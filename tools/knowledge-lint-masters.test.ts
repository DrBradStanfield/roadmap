// US-50 AC7: topic-master lint. Static checks run here over fixtures and over the real docs/blog files
// (inside test:all, never date-dependent). The weekly checks take today's date as an argument and run only
// from tools/knowledge-lint.ts. Extends the US-43 lint; there is no second lint.
import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  entryFrom, isAllowed, loadInputs, main, masterViewHash, nextState, queueItem, validateAllowList, staticMasterChecks, staticMasterFindings, weeklyMasterFindings,
  writeMasterHashes, type AllowEntry, type LintState, type MastersConfig,
} from './knowledge-lint';

const SRC = (checked = '2026-10-20', name = 'nih-ods') => `[{"name":"${name}","url":"https://ods.od.nih.gov/x","checked":"${checked}","fingerprint":"abc"}]`;
const entry = (handle: string, type: string, front: string[], body = '') =>
  entryFrom({ handle, type, title: handle }, `---\ntitle: "${handle}"\n${front.join('\n')}${front.length ? '\n' : ''}---\n${body}`);
const KEY = '## Key safety points\n\n- May interact with warfarin [1].\n- Not in pregnancy [1].\n- Mild bloating [1].\n';
const master = (handle: string, front: string[] = [`reviewed: "2026-10-20"`, `sources: ${SRC()}`], body = `## Current view (reviewed 20 October 2026)\n\nShort [post-a].\n\n${KEY}\n## References\n\n[1] Smith.\n`) =>
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
  it('fails a source name outside consumerlab, nih-ods and brad-video', () => {
    const { fails } = staticMasterFindings([master('n', [`reviewed: "2026-10-20"`, `sources: ${SRC('2026-10-20', 'NIH ODS')}`])], '', CFG);
    expect(fails.map((f) => f.detail)).toEqual(['item 0 name must be one of consumerlab, nih-ods, brad-video']);
  });
  it('fails a frontmatter key that appears twice, and a reference with a view heading but no reviewed', () => {
    const dup = master('d1', [`reviewed: "2026-10-20"`, `sources: ${SRC()}`, `reviewed: "2026-10-21"`]);
    const noKeys = entry('d2', 'reference', [], '## Current evidence position\n\nText.\n');
    const { fails } = staticMasterFindings([dup, noKeys], '', CFG);
    expect(fails.map((f) => `${f.handle}:${f.item}:${f.detail}`).sort()).toEqual(['d1:reviewed:appears more than once', 'd2:reviewed:missing', 'd2:sources:missing']);
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
  const body = `## Current view (reviewed 20 October 2026)\n\nSee doi 10.1000/abc.123 and a trial [1].\n\n${KEY}\n## References\n\n[1] Smith. https://doi.org/10.1000/DEF456\n`;
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

describe('US-50 AC12 static: key safety points after the view (warn only)', () => {
  const warned = (body: string) => staticMasterFindings([master('m', undefined, body)], '', CFG);
  const VIEW = '## Current view (reviewed 20 October 2026)\n\nShort.\n\n';
  const REFS = '\n## References\n\n[1] Smith.\n2. Jones.\n';
  it('is silent on sound key points, and on a reference with no view', () => {
    expect(warned(`${VIEW}${KEY}${REFS}`).warns).toEqual([]);
    expect(warned(`${VIEW}## Key safety points\n\n- One [1, 2].\n- Two\n  wrapped [2].\n- Three [1–2].\n${REFS}`).warns).toEqual([]);
    expect(staticMasterFindings([entry('old', 'reference', [], '## Dosing\n\n1 g.\n')], '', CFG).warns).toEqual([]);
  });
  it.each([
    ['missing', `${VIEW}${REFS}`, 'needs one "## Key safety points" section after the view (found 0)'],
    ['not directly after the view', `${VIEW}## Brad's videos on this topic\n\nNone yet.\n\n${KEY}${REFS}`, 'must come directly after the view section'],
    ['two bullets', `${VIEW}## Key safety points\n\n- One [1].\n- Two [1].\n${REFS}`, 'has 2 bullets (3 to 8)'],
    ['nine bullets', `${VIEW}## Key safety points\n\n${'- A point [1].\n'.repeat(9)}${REFS}`, 'has 9 bullets (3 to 8)'],
    ['over 1,500 characters', `${VIEW}## Key safety points\n\n- ${'x'.repeat(1_500)} [1].\n- Two [1].\n- Three [1].\n${REFS}`, 'characters (at most 1500)'],
    ['a bullet with no marker', `${VIEW}## Key safety points\n\n- One [1].\n- Two.\n- Three [1].\n${REFS}`, 'cites no [n] marker: - Two.'],
    ['a marker with no reference line', `${VIEW}## Key safety points\n\n- One [1].\n- Two [3].\n- Three [1].\n${REFS}`, 'cites [3] with no reference line'],
  ])('warns, never fails, when the section is %s', (_, body, detail) => {
    const r = warned(body);
    expect(r.fails).toEqual([]);
    expect(rules(r.warns)).toEqual(['master-key-points']);
    expect(r.warns[0].detail).toContain(detail);
  });
});

describe('US-50 AC7 static: lint-allowlist.json waivers apply in test:all, matched as weekly', () => {
  const bad = '---\ntitle: "m"\nreviewed: "2026-10-20"\n---\n## Current view (reviewed 20 October 2026)\n\nX.\n';
  const allow = (e: object) => ({ 'docs/loops/chat-health/lint-allowlist.json': JSON.stringify({ entries: [e] }) });
  const w = { rule: 'master-front', handle: 'm', reason: 'Testing', date: '2026-10-20', who: 'Brad' };
  it('drops a finding a matching waiver covers', () => {
    expect(staticMasterChecks(mkRoot({ 'docs/blog/m.md': bad })).fails.map((f) => f.item)).toEqual(['sources']);
    expect(staticMasterChecks(mkRoot({ 'docs/blog/m.md': bad, ...allow({ ...w, item: 'sources' }) })).fails).toEqual([]);
  });
  it('keeps a finding a waiver does not match (other item, rule or handle)', () => {
    for (const x of [{ ...w, item: 'reviewed' }, { ...w, rule: 'master-gate' }, { ...w, handle: 'other' }]) {
      expect(staticMasterChecks(mkRoot({ 'docs/blog/m.md': bad, ...allow(x) })).fails.map((f) => f.item)).toEqual(['sources']);
    }
  });
  it('stops on an invalid waiver (no who)', () => {
    expect(() => staticMasterChecks(mkRoot({ 'docs/blog/m.md': bad, ...allow({ ...w, who: '' }) }))).toThrow(/who/);
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
    const cl = [master('m', [`reviewed: "2026-10-20"`, `sources: ${SRC('2026-09-15', 'consumerlab')}`])];
    expect(rules(weeklyMasterFindings(cl, '2026-10-21', null, CFG, none))).toEqual(['source-stale']);
  });
  it('never flags a brad-video source as stale: it is dated by its post, not fetched', () => {
    const es = [master('m', [`reviewed: "2026-10-20"`, `sources: ${SRC('2026-01-01', 'brad-video')}`])];
    expect(weeklyMasterFindings(es, '2026-10-21', null, CFG, none)).toEqual([]);
  });

  describe('overlapping masters (a shared DOI) go to adversary review', () => {
    const m = (h: string, view: string, doi: string) => master(h, undefined, `## Current view (reviewed 20 October 2026)\n\n${view}\n\n## References\n\n[1] A trial. https://doi.org/${doi}\n`);
    it('flags a pair that shares a DOI though neither mentions the other, with both conclusions', () => {
      const es = [m('a', 'A helps sleep.', '10.1000/SHARED'), m('b', 'B does not help sleep.', '10.1000/shared'), m('c', 'C is fine.', '10.1000/other')];
      const f = weeklyMasterFindings(es, '2026-10-20', null, CFG, none).filter((x) => x.rule === 'master-overlap');
      expect(f).toHaveLength(1);
      expect(f[0].pair).toEqual(['a', 'b']);
      expect(f[0].item).toBe('10.1000/shared');
      expect(f[0].detail).toContain('A helps sleep.');
      expect(f[0].detail).toContain('B does not help sleep.');
    });
    it('three masters sharing one DOI keep all three pairs, each with its own queue id', () => {
      const es = [m('a', 'A.', '10.1000/s'), m('b', 'B.', '10.1000/s'), m('c', 'C.', '10.1000/s')];
      const f = weeklyMasterFindings(es, '2026-10-20', null, CFG, none).filter((x) => x.rule === 'master-overlap');
      expect(f.map((x) => x.pair!.join('+'))).toEqual(['a+b', 'a+c', 'b+c']);
      expect(new Set(f.map((x) => queueItem(x).id)).size).toBe(3);
      expect(queueItem({ ...f[0], pair: ['b', 'a'] }).id).toBe(queueItem(f[0]).id);
      // A finding with no pair keeps its old id (rule|handle|item), so existing queue items still dedupe.
      expect(queueItem({ rule: 'grokipedia', handle: 'h', item: 'i' }).id).toBe(createHash('sha256').update('grokipedia|h|i').digest('hex').slice(0, 12));
    });
    it('is silent for masters with no shared DOI, and ignores unrewritten references', () => {
      const es = [m('a', 'A.', '10.1000/x'), m('b', 'B.', '10.1000/y'), entry('old', 'reference', [], '[1] https://doi.org/10.1000/x\n')];
      expect(weeklyMasterFindings(es, '2026-10-20', null, CFG, none)).toEqual([]);
    });
  });

  describe('current view changed, a registered place did not', () => {
    const view = (t: string) => `## Current view (reviewed 20 October 2026)\n\n${t} [post-a].\n\n## Dosing\n\nx\n`;
    const cfg: MastersConfig = { productIngredients: [], places: [{ topic: 'm', file: 'docs/products.md', snippet: 'Creatine 5 g' }] };
    const file = (extra: string) => () => `Intro.\n\n${extra}Creatine 5 g daily in the blend.\n\nOutro.\n`;
    const ID = 'docs/products.md: Creatine 5 g';
    /** A waiver for this place, scoped to one current view (round-2 N3). */
    const waiveFor = (t: string): AllowEntry => ({ rule: 'master-places', handle: 'm', item: ID, view: masterViewHash(view(t)), reason: 'Dose unchanged on purpose', date: '2026-10-20', who: 'Brad' });
    const waive = waiveFor('One');
    const stateOf = (o: string) => JSON.parse(readFileSync(join(o, 'docs/loops/chat-health/lint-state.json'), 'utf8')) as LintState;
    const unrewritten = entry('m', 'reference', [], 'Body.\n');
    /** A master whose view "One" is stored, its place included (seeded through a waiver). */
    const seeded = () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      writeMasterHashes(o, '2026-10-20', [master('m', undefined, view('One'))], cfg, [waive]);
      return { o, s: stateOf(o), read: (rel: string) => readFileSync(join(o, rel), 'utf8') };
    };
    it('flags the unchanged place; line numbers do not matter, text anchors do', () => {
      const { o, s, read } = seeded();
      expect(Object.keys(s.masters!)).toEqual(['m']);
      const changedView = [master('m', undefined, view('Two'))];
      const f = weeklyMasterFindings(changedView, '2026-10-27', s, cfg, read);
      expect(f.map((x) => `${x.rule}:${x.handle}:${x.item}`)).toEqual([`master-places:m:${ID}`]);
      // Lines added above the anchor move it but do not count as a change.
      writeFileSync(join(o, 'docs/products.md'), file('New line one.\n\nNew paragraph.\n\n')());
      expect(weeklyMasterFindings(changedView, '2026-10-27', s, cfg, read).map((x) => x.rule)).toEqual(['master-places']);
      // Editing the anchored paragraph counts as a change: no finding.
      writeFileSync(join(o, 'docs/products.md'), 'Creatine 5 g daily, now 6 g in some.\n');
      expect(weeklyMasterFindings(changedView, '2026-10-27', s, cfg, read)).toEqual([]);
    });
    it('is silent when the view is unchanged and when no place is registered', () => {
      const { s, read } = seeded();
      expect(weeklyMasterFindings([master('m', undefined, view('One'))], '2026-10-27', s, cfg, read)).toEqual([]);
      expect(weeklyMasterFindings([master('m', undefined, view('Two'))], '2026-10-27', s, CFG, read)).toEqual([]);
    });
    it('a first rewrite with no stored hash still checks its registered places', () => {
      const { s, read } = seeded();
      const f = weeklyMasterFindings([master('m', undefined, view('Two'))], '2026-10-27', { ...s, masters: undefined }, cfg, read);
      expect(f.map((x) => x.detail)).toEqual(['no earlier hash for this place (first rewrite or newly registered); check it follows the current view']);
    });
    it('places hashed before the first rewrite: a place the rewrite changed passes, one it left alone is flagged', () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      expect(writeMasterHashes(o, '2026-10-01', [unrewritten], cfg, []).unwaived).toEqual([]);
      expect(stateOf(o).masters!.m.hash).toBe('');
      const read = (rel: string) => readFileSync(join(o, rel), 'utf8');
      expect(weeklyMasterFindings([master('m', undefined, view('One'))], '2026-10-20', stateOf(o), cfg, read).map((x) => x.rule)).toEqual(['master-places']);
      writeFileSync(join(o, 'docs/products.md'), 'Creatine 5 g daily, now 6 g in some.\n');
      expect(weeklyMasterFindings([master('m', undefined, view('One'))], '2026-10-20', stateOf(o), cfg, read)).toEqual([]);
    });
    it('publish then weekly: an unwaived finding keeps the earlier hashes and exits 1, until the place changes or a waiver lands', async () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      writeMasterHashes(o, '2026-10-01', [unrewritten], cfg, []);
      const base = stateOf(o).masters!.m;
      const read = (rel: string) => readFileSync(join(o, rel), 'utf8');
      // Publish of the first rewrite with the place untouched: held, and the weekly run still sees the drift.
      const one = [master('m', undefined, view('One'))];
      const r1 = writeMasterHashes(o, '2026-10-20', one, cfg, []);
      expect(r1.unwaived.map((f) => f.item)).toEqual([ID]);
      expect(stateOf(o).masters!.m).toEqual(base);
      expect(weeklyMasterFindings(one, '2026-10-27', stateOf(o), cfg, read).map((x) => x.rule)).toEqual(['master-places']);
      // The place follows the master: the next publish advances it, and the weekly run is silent.
      writeFileSync(join(o, 'docs/products.md'), 'Creatine 5 g daily, now 6 g in some.\n');
      expect(writeMasterHashes(o, '2026-10-28', one, cfg, []).unwaived).toEqual([]);
      expect(weeklyMasterFindings(one, '2026-11-03', stateOf(o), cfg, read)).toEqual([]);
      // A second change of view with the place untouched is held again; a waiver then lets it advance.
      const two = [master('m', undefined, view('Two'))];
      expect(writeMasterHashes(o, '2026-11-10', two, cfg, []).unwaived).toHaveLength(1);
      expect(weeklyMasterFindings(two, '2026-11-17', stateOf(o), cfg, read).map((x) => x.rule)).toEqual(['master-places']);
      expect(writeMasterHashes(o, '2026-11-18', two, cfg, [waiveFor('Two')]).unwaived).toEqual([]);
      expect(stateOf(o).masters!.m.at).toBe('2026-11-18');
      expect(weeklyMasterFindings(two, '2026-11-24', stateOf(o), cfg, read)).toEqual([]);
    });
    it('the CLI exits 1 on an unwaived finding at publish', async () => {
      const o = mkRoot({ 'docs/products.md': file('')(), 'docs/blog/m.md': `---\ntitle: "m"\nreviewed: "2026-10-20"\nsources: ${SRC()}\n---\n${view('One')}` },
        { masters: { productIngredients: [], places: cfg.places } });
      const log: string[] = [];
      expect(await main(['--write-master-hashes', '--date', '2026-10-20'], o, (x) => log.push(x))).toBe(1);
      expect(log.join('\n')).toContain(`FAIL master-places m: ${ID}`);
    });
    it('reports a place whose anchor text is gone', () => {
      const { o, s } = seeded();
      writeFileSync(join(o, 'docs/products.md'), 'Reworded entirely.\n');
      const f = weeklyMasterFindings([master('m', undefined, view('One'))], '2026-10-27', s, cfg, (rel) => readFileSync(join(o, rel), 'utf8'));
      expect(f.map((x) => x.detail ?? '').join()).toContain('anchor text not found');
    });
    it('is waived by an allow-list entry with who and date, matched on the place and the view hash', () => {
      const f = { rule: 'master-places' as const, handle: 'm', item: ID, view: waive.view };
      expect(isAllowed(f, [waive])).toBe(true);
      expect(isAllowed({ ...f, item: 'other' }, [waive])).toBe(false);
      expect(isAllowed({ ...f, view: 'other-view' }, [waive])).toBe(false);
      expect(isAllowed(f, [{ ...waive, view: undefined }])).toBe(false);
      expect(() => validateAllowList({ entries: [{ ...waive, view: undefined }] })).toThrow(/view/);
    });
    it('a waiver covers only the view it names: a later change of view re-opens the place (round-2 probe L1)', () => {
      const { o, read } = seeded();
      const three = [master('m', undefined, view('Three'))];
      const raw = weeklyMasterFindings(three, '2026-10-27', stateOf(o), cfg, read);
      expect(raw.filter((f) => !isAllowed(f, [waive])).map((f) => f.rule)).toEqual(['master-places']);
      expect(writeMasterHashes(o, '2026-10-27', three, cfg, [waive]).unwaived).toHaveLength(1);
    });
    it('a place registered after the rewrite is flagged once, then cleared by editing it (probe L2)', () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      const one = [master('m', undefined, view('One'))];
      const s0 = { ...stateOf(o), masters: {} };
      writeFileSync(join(o, 'docs/loops/chat-health/lint-state.json'), JSON.stringify(s0));
      expect(writeMasterHashes(o, '2026-10-20', one, cfg, []).unwaived).toHaveLength(1);
      writeFileSync(join(o, 'docs/products.md'), 'Creatine 5 g daily, now 6 g in some.\n');
      expect(writeMasterHashes(o, '2026-10-21', one, cfg, []).unwaived).toEqual([]);
      expect(weeklyMasterFindings(one, '2026-10-27', stateOf(o), cfg, (rel) => readFileSync(join(o, rel), 'utf8'))).toEqual([]);
    });
    it('a place edited after a hold clears it; publishing no longer stays stuck (probe L3)', () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      writeMasterHashes(o, '2026-10-20', [master('m', undefined, view('One'))], CFG, []);
      const two = [master('m', undefined, view('Two'))];
      expect(writeMasterHashes(o, '2026-10-21', two, cfg, []).unwaived).toHaveLength(1);
      writeFileSync(join(o, 'docs/products.md'), 'Creatine 5 g daily, now 6 g in some.\n');
      expect(writeMasterHashes(o, '2026-10-22', two, cfg, []).unwaived).toEqual([]);
      expect(stateOf(o).masters!.m.hash).toBe(masterViewHash(view('Two')));
    });
    it('a held master keeps the earlier hash of a place that did change, so it is not flagged next week', () => {
      const cfg2: MastersConfig = { productIngredients: [], places: [...cfg.places, { topic: 'm', file: 'docs/products.md', snippet: 'Outro' }] };
      const o = mkRoot({ 'docs/products.md': file('')() });
      writeMasterHashes(o, '2026-10-20', [master('m', undefined, view('One'))], cfg2, [waive, { ...waive, item: 'docs/products.md: Outro' }]);
      writeFileSync(join(o, 'docs/products.md'), 'Intro.\n\nCreatine 5 g daily in the blend.\n\nOutro, edited.\n');
      const two = [master('m', undefined, view('Two'))];
      expect(writeMasterHashes(o, '2026-10-21', two, cfg2, []).unwaived.map((f) => f.item)).toEqual([ID]);
      const f = weeklyMasterFindings(two, '2026-10-27', stateOf(o), cfg2, (rel) => readFileSync(join(o, rel), 'utf8'));
      expect(f.map((x) => x.item)).toEqual([ID]);
    });
    it('writeMasterHashes keeps every other state key, and a later run of nextState keeps the masters section', () => {
      const o = mkRoot({ 'docs/products.md': file('')() });
      const before = stateOf(o);
      const r = writeMasterHashes(o, '2026-10-20', [master('m', undefined, view('One'))], cfg, [waive]);
      expect(r.written).toBe(1);
      const after = stateOf(o);
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
