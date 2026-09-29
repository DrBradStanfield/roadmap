// US-43: the weekly knowledge lint, deterministic half (knowledge-refresh plan
// Phase 3 and decision 6). Every rule runs on fixtures here; the real corpus
// run is the baseline in the build report, not a test.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  SLICE_WEEKS, entryFrom, splitReferences, findMarkers, ruleMarkers, ruleIdentifiers,
  ruleGrokipedia, doseTokens, ruleDose, productMentions, lintEntry, validateAllowList,
  isAllowed, bucketOf, contentHash, selectDue, nextState, algorithmExcerpt, checkLinks,
  renderReport, runLint, main, type Finding, type LintState, type Topic,
} from './knowledge-lint';

const ref = (body: string, summary = '', handle = 'x-ref') =>
  entryFrom({ handle, type: 'reference', title: 'X', summary, keywords: ['x'] }, `---\ntitle: "X"\n---\n${body}`);

describe('splitReferences (AC1: every [n] resolves)', () => {
  it('reads [n], n. and escaped n\\. lines, joins continuation lines, and stops at the next heading of the same level', () => {
    const body = [
      'Claim one [1]. Claim two [2].',
      '## 8. References',
      '[1] Grokipedia. "X." [https://grokipedia.com/page/X](https://grokipedia.com/page/X)',
      '2\\. [Some title',
      '](https://pubmed.ncbi.nlm.nih.gov/123/)',
      '3. https://doi.org/10.1000/abc',
      '## 9. After',
      '1. a numbered step, not a reference',
    ].join('\n');
    const { text, refs } = splitReferences(body);
    expect([...refs.keys()]).toEqual([1, 2, 3]);
    expect(refs.get(2)).toContain('pubmed.ncbi.nlm.nih.gov/123');
    expect(text).toContain('a numbered step');
    expect(text).not.toContain('Grokipedia');
  });
  it('reads the corpus shapes found on the first real run: "## **6\\. References**", a narrow no-break space, a [156-173] range line, and a list collapsed onto one line', () => {
    expect([...splitReferences('## **6\\. References**\n\n6\\. [https://a.org](https://a.org)').refs.keys()]).toEqual([6]);
    expect([...splitReferences('## **Reference List**\n\n1\\. x').refs.keys()]).toEqual([1]);
    expect([...splitReferences('## 9. References\n[156-158] Green tea studies.\n[157] Hursel R.').refs.keys()]).toEqual([156, 157, 158]);
    const collapsed = '## **Reference List**\n\n1\\.  [https://a.org/1/](https://a.org/1/)2\\.  [https://a.org/2/](https://a.org/2/)';
    expect([...splitReferences(collapsed).refs.keys()]).toEqual([1, 2]);
  });
  it('treats a bold or plain "References:" line as a section that ends at any heading', () => {
    const { refs, text } = splitReferences('Body [1].\n\n**References**\n\n1. First\n\n### Next\n2. not a ref');
    expect([...refs.keys()]).toEqual([1]);
    expect(text).toContain('2. not a ref');
  });
  it('keeps a bold "Sources:" line in the body: in the corpus it lists raw-material sources, not citations', () => {
    const { refs, text } = splitReferences('Body [1].\n\n**Sources:**\n- Bovine trachea [1]\n\n## References\n[1] One');
    expect([...refs.keys()]).toEqual([1]);
    expect(text).toContain('Bovine trachea');
  });
});

describe('findMarkers', () => {
  it('expands lists and ranges, reads escaped markers, and marks inline links as self-resolving', () => {
    const m = findMarkers('a [1] b [2,3] c [4-6] d \\[7\\] e [8](https://x.org) f [9](#user-content-fn-9) g [2023](https://y)');
    expect(m.flatMap(x => x.nums)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(m.find(x => x.nums[0] === 8)!.inline).toBe(true);
    expect(m.find(x => x.nums[0] === 9)!.inline).toBe(false);
  });
});

describe('ruleMarkers (AC1)', () => {
  it('reports a marker with no reference line and a reference line nothing cites', () => {
    const e = ref('A [1]. B [4]. C [5](https://z.org).\n\n## References\n\n[1] One\n\n[2] Two\n\n[5] Five');
    const f = ruleMarkers(e);
    expect(f.filter(x => x.rule === 'unresolved-marker').map(x => x.item)).toEqual(['[4]']);
    expect(f.filter(x => x.rule === 'uncited-reference').map(x => x.item)).toEqual(['[2]']);
  });
  it('reports a numbered list with no marker at all once, as a bibliography', () => {
    const f = ruleMarkers(ref('No markers here.\n\n## References\n\n1. https://a.org\n2. https://b.org'));
    expect(f).toEqual([expect.objectContaining({ rule: 'uncited-list', item: '2 references, no marker' })]);
  });
  it('reports every marker when there is no reference section', () => {
    expect(ruleMarkers(ref('A [1]. B [2].')).map(x => x.item)).toEqual(['[1]', '[2]']);
  });
});

describe('ruleIdentifiers (AC7: DOI and PMID shape)', () => {
  it('flags a malformed DOI, a DOI whose link text and target differ, a Bookshelf id called a PMID, and an over-long PMID URL', () => {
    const e = ref([
      'Good doi: [10.1155/2021/9996371](https://doi.org/10.1155/2021/9996371).',
      'Bad doi: N/A. Short 10.12/abc here.',
      'Swapped [10.1000/aaa](https://doi.org/10.1000/bbb).',
      'PMID: NBK564301. PMID: [12345](https://pubmed.ncbi.nlm.nih.gov/54321/).',
      'https://pubmed.ncbi.nlm.nih.gov/1234567890/',
    ].join('\n'));
    const items = ruleIdentifiers(e).map(f => `${f.rule} ${f.item}`);
    expect(items).toEqual(expect.arrayContaining([
      'doi-shape doi: N/A', 'doi-shape 10.12/abc', 'id-mismatch 10.1000/aaa -> 10.1000/bbb',
      'pmid-shape NBK564301', 'id-mismatch PMID 12345 -> 54321', 'pmid-shape 1234567890',
    ]));
    expect(items.some(i => i.includes('9996371'))).toBe(false);
  });
  it('passes the real corpus shapes the first run over-reported: parentheses, query strings, URL encoding, turndown escapes', () => {
    const e = ref([
      'doi: [10.1016/S0028-3908(02)00217-4](https://doi.org/10.1016/S0028-3908(02)00217-4)',
      'https://doi.org/10.1007/s43630-023-00453-x?utm_source=chatgpt.com',
      'https://doi.org/10.1016/0014-5793%2876%2980996-9',
      'https://doi.org/10.1161/circ.152.suppl\\_3.4371606',
      '[10.1002/(SICI)1099-1573(200005)14:3<167::AID-PTR580>3.0.CO;2-V](https://doi.org/10.1002/(SICI)1099-1573(200005)14:3<167::AID-PTR580>3.0.CO;2-V)',
      'https://doi.org/10.1663/0013-0001(2003)057%5B0604:EOCSHL%5D2.0.CO;2',
    ].join('\n'));
    expect(ruleIdentifiers(e)).toEqual([]);
  });
});

describe('ruleGrokipedia (AC7: no body cites Grokipedia)', () => {
  it('counts reference entries, via entries, mentions, and sentences whose only support is Grokipedia', () => {
    const e = ref([
      'Only grok here [1]. Only via here [2]. Mixed support [1][3]. Uncited sentence.',
      '',
      '## References',
      '[1] Grokipedia. "X." https://grokipedia.com/page/X',
      '[2] Smith 2020, via Grokipedia.',
      '[3] Jones J. Trial. doi: 10.1000/abc',
    ].join('\n'));
    const { findings, stats } = ruleGrokipedia(e);
    expect(stats).toMatchObject({ grokRefs: 2, grokVia: 1, grokMentions: 3, grokOnlyDirect: 1, grokOnlyAny: 2 });
    expect(findings).toHaveLength(1);
    expect(findings[0].rule).toBe('grokipedia');
  });
  it('is silent on a body that never names Grokipedia', () => {
    expect(ruleGrokipedia(ref('Fine [1].\n\n## References\n[1] Jones.')).findings).toEqual([]);
  });
});

describe('doseTokens (AC2 tokeniser rules)', () => {
  const keys = (s: string) => [...doseTokens(s).keys()].sort();
  it('reads ranges with hyphen, en dash and "to" as two numbers sharing the unit', () => {
    expect(keys('900-1500 mg/day')).toEqual(keys('900 to 1,500 mg daily'));
    expect(keys('2–4 g')).toEqual(['ug:2000000', 'ug:4000000']);
  });
  it('makes 1 g equal 1,000 mg and mcg equal µg', () => {
    expect(keys('1 g')).toEqual(keys('1,000 mg'));
    expect(keys('500 mcg')).toEqual(keys('500 µg'));
  });
  it('ignores citation markers, numbers glued to letters, years and bare numbers', () => {
    expect(keys('Vitamin B12 in 2021 [3] with 12 people')).toEqual([]);
    expect(keys('B12 1000 mcg')).toEqual(['ug:1000']);
  });
  it('keeps lab units apart from mass units', () => {
    expect(keys('LDL 1.4 mmol/L or 55 mg/dL')).toEqual(['mg/dl:55', 'mmol/l:1.4']);
  });
});

describe('ruleDose (summary versus body)', () => {
  it('reports a summary dose the body never states, and passes one it states in another form', () => {
    const body = 'Trials used 900 to 1,500 mg daily. Some used 1.5 g.';
    expect(ruleDose(ref(body, 'Typical doses 900-1500 mg/day.'))).toEqual([]);
    const f = ruleDose(ref(body, 'Typical doses 500-1500 mg/day; 10,000 IU.'));
    expect(f.map(x => x.item)).toEqual(['500 mg', '10,000 IU']);
  });
});

describe('productMentions (AC7: product mentions do not rise)', () => {
  it('counts product names in the body', () => {
    expect(productMentions('MicroVitamin and MicroVitamin+ and Sleep by Dr Brad; microvitamin')).toBe(4);
  });
  it('reports a rise over the stored baseline', () => {
    const e = ref('MicroVitamin twice: MicroVitamin.');
    const state: LintState = { version: 1, lastRun: null, cursor: 0, algorithm: {}, entries: { 'x-ref': { hash: 'h', products: 1 } } };
    expect(lintEntry(e, state).findings.filter(f => f.rule === 'product-rise').map(f => f.item)).toEqual(['1 -> 2']);
  });
});

describe('allow-list (deliberate divergences)', () => {
  const entry = { rule: 'unresolved-marker', handle: 'diet', reason: 'Markers point to the AHA paper.', date: '2026-09-29', who: 'Brad' };
  it('accepts a complete entry and refuses one missing its reason, date or who', () => {
    expect(validateAllowList({ entries: [entry] })).toHaveLength(1);
    expect(() => validateAllowList({ entries: [{ ...entry, reason: '' }] })).toThrow(/reason/);
    expect(() => validateAllowList({ entries: [{ ...entry, date: 'soon' }] })).toThrow(/date/);
    expect(() => validateAllowList({ entries: [{ ...entry, handle: undefined }] })).toThrow(/handle or pair/);
  });
  it('matches by rule and handle, by an unordered pair, and by item when one is given', () => {
    const allow = validateAllowList({ entries: [
      entry,
      { rule: 'entry-vs-algorithm', pair: ['algorithm:lipids', 'hyperlipidaemia'], item: 'LDL target', reason: 'r', date: '2026-09-29', who: 'Brad' },
    ] });
    const f = (x: Partial<Finding>): Finding => ({ rule: 'unresolved-marker', handle: 'diet', item: '[3]', ...x } as Finding);
    expect(isAllowed(f({}), allow)).toBe(true);
    expect(isAllowed(f({ handle: 'sleep' }), allow)).toBe(false);
    expect(isAllowed(f({ rule: 'entry-vs-algorithm', handle: 'hyperlipidaemia', pair: ['hyperlipidaemia', 'algorithm:lipids'], item: 'LDL target' }), allow)).toBe(true);
    expect(isAllowed(f({ rule: 'entry-vs-algorithm', handle: 'hyperlipidaemia', pair: ['hyperlipidaemia', 'algorithm:lipids'], item: 'HDL' }), allow)).toBe(false);
  });
});

describe('algorithmExcerpt', () => {
  const algo = '## 3. Thresholds\n### LDL (mmol/L)\nLDL < 1.4\n### HDL\nHDL > 1\n## 4. Next\nnope';
  it('takes a heading through to the next heading of the same or higher level', () => {
    expect(algorithmExcerpt(algo, ['LDL (mmol/L)'])).toBe('### LDL (mmol/L)\nLDL < 1.4');
    expect(algorithmExcerpt(algo, ['3. Thresholds'])).toContain('HDL > 1');
    expect(algorithmExcerpt(algo, ['3. Thresholds'])).not.toContain('nope');
  });
  it('throws on a heading the algorithm no longer has, so a rename is loud', () => {
    expect(() => algorithmExcerpt(algo, ['Gone'])).toThrow(/Gone/);
  });
});

describe('selector (changed since last run plus a rotating slice)', () => {
  const entries = Array.from({ length: 60 }, (_, i) => ref(`body ${i}`, '', `h-${i}`));
  const topics: Topic[] = [{ topic: 'lipids', headings: ['LDL'], handles: ['h-1'] }];
  const algo = '### LDL\nLDL < 1.4';
  it('buckets handles stably into 13 slices', () => {
    expect(bucketOf('h-1')).toBe(bucketOf('h-1'));
    expect(new Set(entries.map(e => bucketOf(e.handle))).size).toBeGreaterThan(8);
    expect(Math.max(...entries.map(e => bucketOf(e.handle)))).toBeLessThan(SLICE_WEEKS);
  });
  it('with no state, selects the first slice only', () => {
    const due = selectDue(entries, null, topics, algo);
    expect(due.every(d => d.reasons.join() === 'slice')).toBe(true);
    expect(due.map(d => d.handle)).toEqual(entries.filter(e => bucketOf(e.handle) === 0).map(e => e.handle).sort());
  });
  it('adds changed and new entries and every handle of a topic whose algorithm text changed', () => {
    const state = nextState(entries, null, topics, algo, '2026-09-29', false);
    expect(selectDue(entries, state, topics, algo).every(d => d.reasons.join() === 'slice')).toBe(true);
    const edited = entries.map(e => e.handle === 'h-5' ? ref('edited', '', 'h-5') : e).concat(ref('new', '', 'h-new'));
    const due = selectDue(edited, state, topics, '### LDL\nLDL < 1.8');
    const why = Object.fromEntries(due.map(d => [d.handle, d.reasons]));
    expect(why['h-5']).toContain('changed');
    expect(why['h-new']).toContain('new');
    expect(why['h-1']).toContain('algorithm:lipids');
  });
  it('advances the cursor, drops removed handles, and never raises a product baseline', () => {
    const s0 = nextState([ref('MicroVitamin', '', 'a'), ref('b', '', 'b')], null, [], '', '2026-09-29', false);
    expect(s0.cursor).toBe(0);
    const s1 = nextState([ref('MicroVitamin MicroVitamin', '', 'a')], s0, [], '', '2026-10-04', true);
    expect(s1).toMatchObject({ cursor: 1, lastRun: '2026-10-04' });
    expect(Object.keys(s1.entries)).toEqual(['a']);
    expect(s1.entries.a.products).toBe(1);
    expect(s1.entries.a.hash).toBe(contentHash(ref('MicroVitamin MicroVitamin', '', 'a').raw));
    let s = s1;
    for (let i = 0; i < SLICE_WEEKS - 1; i++) s = nextState([], s, [], '', 'd', true);
    expect(s.cursor).toBe(0);
  });
});

describe('checkLinks (--check-links)', () => {
  it('HEADs each identifier once up to the cap, and reports only a 404 as dead', async () => {
    const calls: string[] = [];
    const fetchImpl = async (url: string) => {
      calls.push(url);
      return { status: url.includes('dead') ? 404 : url.includes('flaky') ? 503 : 302 } as Response;
    };
    const ids = [
      { kind: 'doi' as const, id: '10.1000/ok', handle: 'a' },
      { kind: 'doi' as const, id: '10.1000/ok', handle: 'b' },
      { kind: 'doi' as const, id: '10.1000/dead', handle: 'a' },
      { kind: 'pmid' as const, id: '123', handle: 'a' },
      { kind: 'doi' as const, id: '10.1000/flaky', handle: 'a' },
    ];
    const r = await checkLinks(ids, { fetchImpl, delayMs: 0, cap: 3 });
    expect(calls).toEqual(['https://doi.org/10.1000/ok', 'https://doi.org/10.1000/dead', 'https://pubmed.ncbi.nlm.nih.gov/123/']);
    expect(r.dead.map(f => f.item)).toEqual(['10.1000/dead']);
    expect(r).toMatchObject({ checked: 3, unchecked: 1 });
  });
});

describe('renderReport (LOOP.md: reports ≤150 lines, counts first)', () => {
  it('stays within 150 lines when findings run to thousands, and opens with the counts table', () => {
    const findings: Finding[] = Array.from({ length: 3000 }, (_, i) => ({ rule: 'uncited-reference', handle: `h-${i % 400}`, item: `[${i}]` }));
    const md = renderReport({
      date: '2026-09-29', corpus: { total: 400, pathway: 0, reference: 400, article: 0, guideline: 0 },
      findings, suppressed: 2, allowEntries: 1,
      stats: { grokBodies: 1, grokRefs: 2, grokVia: 1, grokMentions: 3, grokOnlyDirect: 4, grokOnlyAny: 5, productBodies: 1, productMentions: 2 },
      due: [{ handle: 'a', reasons: ['slice'] }], cursor: 0, stateMissing: false, links: null,
    });
    const lines = md.split('\n');
    expect(lines.length).toBeLessThanOrEqual(150);
    expect(md.indexOf('| uncited-reference | 3000 | 400 |')).toBeGreaterThan(0);
    expect(md.indexOf('## Counts')).toBeLessThan(md.indexOf('## Details'));
  });
});

describe('main on a scratch corpus', () => {
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), 'klint-'));
    for (const d of ['docs/blog', 'docs/pathway', 'docs/guideline', 'docs/loops/chat-health']) mkdirSync(join(root, d), { recursive: true });
    writeFileSync(join(root, 'docs/blog/index.json'), JSON.stringify([
      { handle: 'r1', type: 'reference', title: 'R1: x', summary: 'Take 5 mg.', keywords: ['r1'] },
      { handle: 'p1', type: 'pathway', title: 'P1', summary: 'Clinical pathway for p1.', keywords: ['p1'] },
    ]));
    writeFileSync(join(root, 'docs/blog/r1.md'), '---\ntitle: "R1"\n---\nClaim [1]. Take 10 mg.\n\n## References\n[1] Grokipedia. https://grokipedia.com/page/R1\n');
    writeFileSync(join(root, 'docs/pathway/p1.md'), '---\ntitle: "P1"\n---\nNo citations.\n');
    writeFileSync(join(root, 'health_roadmap_algorithm.md'), '### LDL\nLDL < 1.4\n');
    writeFileSync(join(root, 'docs/loops/chat-health/lint-topics.json'), JSON.stringify({ topics: [{ topic: 'lipids', headings: ['LDL'], handles: ['p1'] }] }));
    return root;
  };
  const capture = async (argv: string[], root: string) => {
    const out: string[] = [];
    const code = await main(argv, root, (s: string) => out.push(s));
    return { code, out: out.join('\n') };
  };

  it('--dry-run prints the due list and writes nothing', async () => {
    const root = setup();
    const { code, out } = await capture(['--dry-run'], root);
    expect(code).toBe(0);
    expect(out).toMatch(/due this week/i);
    expect(existsSync(join(root, 'docs/loops/chat-health/lint-state.json'))).toBe(false);
    rmSync(root, { recursive: true });
  });
  it('a full run reports Grokipedia and the dose mismatch, and --out writes the markdown report', async () => {
    const root = setup();
    const outFile = join(root, 'report.md');
    const { code, out } = await capture(['--out', outFile], root);
    expect(code).toBe(0);
    expect(out).toContain('| grokipedia | 1 | 1 |');
    expect(out).toContain('| dose-mismatch | 1 | 1 |');
    expect(readFileSync(outFile, 'utf8')).toContain('## Counts');
    rmSync(root, { recursive: true });
  });
  it('--init-state writes the baseline once and refuses a second time; --save-state advances it', async () => {
    const root = setup();
    const stateFile = join(root, 'docs/loops/chat-health/lint-state.json');
    expect((await capture(['--init-state'], root)).code).toBe(0);
    const s0 = JSON.parse(readFileSync(stateFile, 'utf8'));
    expect(s0).toMatchObject({ cursor: 0, lastRun: null });
    expect(Object.keys(s0.entries).sort()).toEqual(['p1', 'r1']);
    expect((await capture(['--init-state'], root)).code).toBe(1);
    expect((await capture(['--save-state'], root)).code).toBe(0);
    expect(JSON.parse(readFileSync(stateFile, 'utf8')).cursor).toBe(1);
    rmSync(root, { recursive: true });
  });
  it('--append-metrics adds one lint_* row per rule to metrics.csv, with the prior count and delta', async () => {
    const root = setup();
    const csv = join(root, 'docs/loops/chat-health/metrics.csv');
    writeFileSync(csv, 'week,metric,count_7d,count_prior_7d,delta_pct,source,note\n2026-W39,lint_grokipedia,2,,,x,y\n');
    expect((await capture(['--append-metrics', '2026-W40'], root)).code).toBe(0);
    const rows = readFileSync(csv, 'utf8').trim().split('\n');
    expect(rows).toContain('2026-W40,lint_grokipedia,1,2,-50,tools/knowledge-lint.ts,weekly lint');
    expect(rows).toContain('2026-W40,lint_dose_mismatch,1,,,tools/knowledge-lint.ts,weekly lint');
    rmSync(root, { recursive: true });
  });
  it('--queue writes deterministic findings to lint-fix-queue.json as knowledge-side, once across weeks', async () => {
    const root = setup();
    const file = join(root, 'docs/loops/chat-health/lint-fix-queue.json');
    expect((await capture(['--queue'], root)).code).toBe(0);
    const q1 = JSON.parse(readFileSync(file, 'utf8'));
    expect(q1.items.map((i: { rule: string }) => i.rule).sort()).toEqual(['dose-mismatch', 'grokipedia']);
    expect(q1.items[0]).toMatchObject({ side: 'knowledge', handles: ['r1'], fix_handle: 'r1', status: 'open' });
    expect(q1.items[0].id).toMatch(/^[0-9a-f]{12}$/);
    expect((await capture(['--queue'], root)).code).toBe(0);
    expect(JSON.parse(readFileSync(file, 'utf8')).items).toHaveLength(2);
    rmSync(root, { recursive: true });
  });
  it('an allow-listed finding is suppressed and counted', async () => {
    const root = setup();
    writeFileSync(join(root, 'docs/loops/chat-health/lint-allowlist.json'), JSON.stringify({ entries: [
      { rule: 'dose-mismatch', handle: 'r1', reason: 'test', date: '2026-09-29', who: 'test' },
    ] }));
    const r = await runLint(root, {});
    expect(r.findings.some(f => f.rule === 'dose-mismatch')).toBe(false);
    expect(r.suppressed).toBe(1);
    rmSync(root, { recursive: true });
  });
});
