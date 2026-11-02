/**
 * US-70 condition guides. AC4: each guide's `thresholds:` values equal the
 * health-core constants they name, so a guide never drifts from the algorithm
 * (free, in test:all; a mismatch blocks landing). AC7: a condition guide loads
 * first and whole, so its red flags load beside two large whole-only entries.
 */
import { describe, it, expect, vi, afterEach, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import path from 'path';
import * as units from '../../packages/health-core/src/units';
import { parseFrontmatter } from './frontmatter';
import { loadBlogIndex, type BlogIndexEntry } from './blog-index.server';
import { loadMatchedContent, MAX_BLOG_CHARS } from './matched-content';

const ROOT = process.cwd();
const FIXTURE = fs.readFileSync(path.join(ROOT, 'tools/fixtures/condition-guide/sound.md'), 'utf-8');
const EMERGENCY_LINE = '(111 in NZ, 000 in Australia, 911 in the US, 999 in the UK)';

/**
 * Each `thresholds:` item whose value differs from the units.ts constant its ref
 * names, at the precision the guide states (1.4 matches 1.4; 3.4 matches
 * LDL_THRESHOLDS.borderline, about 3.36), or whose ref names no number.
 */
function thresholdErrors(raw: string): string[] {
  const list = parseFrontmatter(raw)?.thresholds;
  if (!Array.isArray(list) || !list.length) return ['no thresholds list'];
  return list.flatMap(({ ref, value }: { ref: unknown; value: unknown }) => {
    const [name, ...keys] = String(ref).split('.');
    const actual = keys.reduce<unknown>((v, k) => (v as Record<string, unknown> | undefined)?.[k], (units as Record<string, unknown>)[name]);
    if (typeof actual !== 'number' || typeof value !== 'number') return [`${String(ref)}: names no number in health-core units.ts`];
    const places = (String(value).split('.')[1] ?? '').length;
    return Number(actual.toFixed(places)) === value ? [] : [`${String(ref)}: guide says ${value}, health-core says ${actual}`];
  });
}

const guides = () => fs.readdirSync(path.join(ROOT, 'docs/guideline')).filter(f => f.endsWith('.md'))
  .map(f => ({ file: f, raw: fs.readFileSync(path.join(ROOT, 'docs/guideline', f), 'utf-8') }))
  .filter(g => parseFrontmatter(g.raw)?.kind === 'condition');

describe('US-70 AC4: thresholds match health-core', () => {
  it('every condition guide in docs/guideline states only health-core values', () => {
    for (const g of guides()) expect(thresholdErrors(g.raw), g.file).toEqual([]);
  });

  it('the fixture guide passes', () => {
    expect(thresholdErrors(FIXTURE)).toEqual([]);
  });

  it('a value that differs from the constant fails, naming both', () => {
    const wrong = FIXTURE.replace('"ref":"BP_THRESHOLDS.crisisSys","value":180', '"ref":"BP_THRESHOLDS.crisisSys","value":160');
    expect(thresholdErrors(wrong)).toEqual(['BP_THRESHOLDS.crisisSys: guide says 160, health-core says 180']);
    const ldl = FIXTURE.replace('"value":1.4', '"value":1.8');
    expect(thresholdErrors(ldl)).toEqual(['LIPID_TREATMENT_TARGETS.ldlMmol: guide says 1.8, health-core says 1.4']);
  });

  it('compares at the precision the guide states', () => {
    const derived = FIXTURE.replace('"ref":"LIPID_TREATMENT_TARGETS.ldlMmol","value":1.4', '"ref":"LDL_THRESHOLDS.borderline","value":3.4');
    expect(thresholdErrors(derived)).toEqual([]);
    expect(thresholdErrors(derived.replace('"value":3.4', '"value":3.5'))).toEqual([expect.stringMatching(/^LDL_THRESHOLDS.borderline: guide says 3.5, health-core says 3.36/)]);
  });

  it('a ref to no constant, or to an object, fails', () => {
    expect(thresholdErrors(FIXTURE.replace('BP_THRESHOLDS.crisisSys', 'BP_THRESHOLDS.panic'))).toEqual(['BP_THRESHOLDS.panic: names no number in health-core units.ts']);
    expect(thresholdErrors(FIXTURE.replace('BP_THRESHOLDS.crisisSys', 'NOPE.crisisSys'))).toEqual(['NOPE.crisisSys: names no number in health-core units.ts']);
  });
});

describe('US-70 AC7: a condition guide loads first, beside two large whole-only entries', () => {
  const BEETROOT = 'beetroot-benefits-forms-dosing-and-side-effects';
  const CITRULLINE = 'l-citrulline-benefits-forms-dosing-and-side-effects';
  const GUIDE = 'test-condition-guide';
  const PLAIN = 'test-plain-guideline';
  // A guide at the 35,000-character cap whose red flags sit at the top.
  const body = FIXTURE.replace('## What it is\n\nText.', `## What it is\n\n${'Filler text. '.repeat(Math.floor((34_900 - FIXTURE.length) / 13))}`);
  const extra: BlogIndexEntry[] = [
    { title: 'Test condition', handle: GUIDE, url: 'u', tags: [], publishedAt: '', type: 'guideline', kind: 'condition', reviewed: '2026-11-02' },
    { title: 'Plain guideline', handle: PLAIN, url: 'u', tags: [], publishedAt: '', type: 'guideline' },
  ];
  const realRead = fs.readFileSync;
  beforeAll(() => { loadBlogIndex().push(...extra); });
  afterAll(() => { const index = loadBlogIndex(); for (const e of extra) index.splice(index.indexOf(e), 1); });
  afterEach(() => { vi.restoreAllMocks(); });
  const serve = () => vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const handle = path.basename(String(p), '.md');
    if (handle === GUIDE) return body;
    if (handle === PLAIN) return body.replace('kind: "condition"\n', '');
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);

  it('routed last, the guide loads first and whole with its red flags, and both large entries still load, inside the cap', () => {
    serve();
    expect(body.length).toBeGreaterThan(34_000);
    expect(body.length).toBeLessThanOrEqual(35_000);
    const { content, skipped, titles } = loadMatchedContent([BEETROOT, CITRULLINE, GUIDE]);
    expect(skipped).toEqual([]);
    expect(titles[0]).toBe('Test condition');
    expect(content!.startsWith('[guideline — reviewed 2026-11-02]')).toBe(true);
    expect(content).toContain(`Chest pain that spreads to the arm: call your emergency number now\n  ${EMERGENCY_LINE}`);
    expect(content).toContain('## Get help now');
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
  });

  // Two large whole-only posts that leave no room for a third entry: whichever loads first stays.
  const BIG = { 'test-big-a': `---\ntitle: "A"\n---\n\n${'a'.repeat(75_000)}`, 'test-big-b': `---\ntitle: "B"\n---\n\n${'b'.repeat(60_000)}` };
  const serveBig = () => vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const handle = path.basename(String(p), '.md');
    if (handle in BIG) return BIG[handle as keyof typeof BIG];
    if (handle === GUIDE) return body;
    if (handle === PLAIN) return body.replace('kind: "condition"\n', '');
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);

  it('when the routed entries cannot all fit, the guide still loads and a later entry yields', () => {
    serveBig();
    const { content, skipped } = loadMatchedContent(['test-big-a', 'test-big-b', GUIDE]);
    expect(skipped).toEqual(['test-big-b']);
    expect(content).toContain(EMERGENCY_LINE);
    expect(content!.length).toBeLessThanOrEqual(MAX_BLOG_CHARS);
  });

  it('a guideline with no kind: condition, in the same place, is skipped whole: the order is what saves the red flags', () => {
    serveBig();
    const { content, skipped } = loadMatchedContent(['test-big-a', 'test-big-b', PLAIN]);
    expect(skipped).toEqual([PLAIN]);
    expect(content).not.toContain('## Get help now');
  });
});
