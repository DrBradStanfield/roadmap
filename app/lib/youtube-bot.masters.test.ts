/**
 * US-50 AC6: a YouTube comment loads its video's post, plus only the
 * "Current view" or "Current evidence position" section of each master the post
 * names, de-duplicated against the router's picks and capped. These sections
 * sit in their own labelled block and never in "Referenced Blog Articles", so
 * the reply-or-skip rule's input is unchanged.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

const fakes = vi.hoisted(() => {
  const ref = (handle: string, reviewed?: string) => ({
    title: `Master ${handle}`, handle, url: `https://drstanfield.com/blogs/articles/${handle}`, tags: [],
    publishedAt: '2024-01-01T00:00:00Z', type: 'reference' as const, ...(reviewed ? { reviewed } : {}),
  });
  return [
    ref('tm-collagen', '2026-10-20'),
    ref('tm-nad'),
    ref('tm-empty'),
    ref('tm-big', '2026-10-20'),
    ref('tm-huge'),
    ref('tm-master-long', '2026-10-20'),
    ref('tm-safe'), ref('tm-mid1'), ref('tm-mid2'), ref('tm-cited'), ref('tm-numbered'), ref('tm-malformed'), ref('tm-rule'), ref('tm-ix'), ref('tm-dup1'), ref('tm-dup2'),
    ref('tm-keyed'), ref('tm-keylong'), ref('tm-kp-head'), ref('tm-kp-tbw'), ref('tm-kp-rule'), ref('tm-kp-two'), ref('tm-kp-indent'), ref('tm-kp-summary'),
    ...Array.from({ length: 14 }, (_, i) => ref(`tm-stack-${i}`, '2026-10-20')),
    { title: 'An article', handle: 'tm-article', url: 'u', tags: [], publishedAt: '2025-01-01T00:00:00Z' },
  ];
});

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: null }));
vi.mock('./blog-index.server', async (orig) => {
  const real = await orig<typeof import('./blog-index.server')>();
  return { ...real, loadBlogIndex: () => [...real.loadBlogIndex(), ...fakes] };
});
vi.mock('./chat-classifier.server', async (orig) => ({
  ...(await orig<typeof import('./chat-classifier.server')>()),
  classifyMessage: vi.fn(async () => ({ classification: 'ROUTE' })),
}));
vi.mock('./chat-router.server', async (orig) => ({
  ...(await orig<typeof import('./chat-router.server')>()),
  routeQuery: vi.fn(async () => ({ handles: [], rawJson: '{"handles":[]}', usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null })),
}));
vi.mock('./chat.server', async (orig) => ({
  ...(await orig<typeof import('./chat.server')>()),
  getChatCompletion: vi.fn(async () => ({ content: 'SKIP_NO_REPLY', usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, isFallback: false })),
}));

import { runPipeline } from './youtube-bot.server';
import { platformChatCompletion } from './platform-chat.server';
import { currentViewSection, safetySections, masterViews, reducedMaster, MAX_VIEW_CHARS, MASTER_VIEWS_HEADING, MAX_MASTER_VIEW_CHARS, MAX_KEY_POINTS_CHARS, BULLET_LINE } from './youtube-context';
import { MAX_KEY_POINTS_CHARS as CHECKER_MAX_KEY_POINTS_CHARS, BULLET_LINE as CHECKER_BULLET_LINE, keySafetyErrors } from '../../tools/knowledge-batch-check';
import { getChatCompletion } from './chat.server';
import { routeQuery } from './chat-router.server';

const VIEW = '## Current view (reviewed 20 October 2026)\n\nCollagen peptides may improve skin hydration [the-collagen-peptides-for-skin-story-is-changing].';
const files: Record<string, string> = {
  'tm-collagen': `---\ntitle: "Collagen"\nreviewed: "2026-10-20"\n---\n\n# Collagen\n\nIntro.\n\n${VIEW}\n\n## Brad's videos on this topic\n\n- 2025: old video.\n\n## Evidence review\n\nLong review.\n`,
  'tm-nad': `---\ntitle: "NAD"\n---\n\n# NAD\n\n## Current evidence position\n\nAn evidence summary, not Brad's view.\n\n## Evidence review\n\nMore.\n`,
  'tm-empty': `---\ntitle: "Empty"\n---\n\n# Empty\n\n## Evidence review\n\nOnly a review.\n`,
  'tm-big': `---\ntitle: "Big"\n---\n\n## Current view (reviewed 20 October 2026)\n\n${'x'.repeat(MAX_MASTER_VIEW_CHARS)}\n`,
  'tm-safe': `---\ntitle: "Safe"\n---\n\n## Current view (reviewed 20 October 2026)\n\nSafe view.\n\n## 3. Evidence for Benefits\n\nBenefits.\n\n## 5. Safety and Side Effects\n\n### Common Side Effects\n\nMild bloating.\n\n## 6. Drug Interactions\n\nMay interact with warfarin.\n\n## 7. Dietary Sources\n\nFood.\n\n## Cautions\n\nA caution.\n\n## Who Should Not Take It\n\nPregnant people.\n\n## Who Should Consider Taking It\n\nMost adults.\n`,
  'tm-mid1': `---\ntitle: "Mid1"\n---\n\n## Current view (reviewed 20 October 2026)\n\nMid one.\n\n## Safety\n\n${'1'.repeat(MAX_MASTER_VIEW_CHARS - 1_500)}\n`,
  'tm-mid2': `---\ntitle: "Mid2"\n---\n\n## Current view (reviewed 20 October 2026)\n\nMid two.\n\n## Safety\n\n${'2'.repeat(2_000)}\n`,
  'tm-malformed': `---\ntitle: "Malformed"\n---\n\n## Current view (reviewed 20 October 2026)\n\nMalformed view.\n\n${'m'.repeat(7_000)}\n`,
  'tm-rule': `---\ntitle: "Rule"\n---\n\n## Current view (reviewed 20 October 2026)\n\nRule view.\n\n---\n\nText after the rule.\n`,
  'tm-ix': `---\ntitle: "Ix"\n---\n\n## Current view (reviewed 20 October 2026)\n\nIx view.\n\n## 5. Safety and Side Effects\n\nIx small safety.\n\n## 6. Drug Interactions\n\n${'i'.repeat(MAX_MASTER_VIEW_CHARS)}\n`,
  'tm-dup1': `---\ntitle: "Dup1"\n---\n\n## Current view (reviewed 20 October 2026)\n\nDup one.\n\n## Safety\n\n${'d'.repeat(MAX_MASTER_VIEW_CHARS * 0.6)}\n`,
  'tm-dup2': `---\ntitle: "Dup2"\n---\n\n## Current view (reviewed 20 October 2026)\n\nDup two.\n\n## Safety\n\n${'d'.repeat(MAX_MASTER_VIEW_CHARS * 0.6)}\n`,
  'tm-cited':`---\ntitle: "Cited"\n---\n\n## Current view (reviewed 20 October 2026)\n\nCited view [1].\n\n## 3. Evidence\n\nBenefit [1].\n\n## 5. Safety and Side Effects\n\nRare rash [2]. Liver note [3, 5]. Range [6–7]. A DOI link [10.1000/xyz].\n\n## 9. References\n\n[1] Ref one.\n\n[2] Ref two.\n\n[3] Ref three.\n\n[4] Ref four.\n\n[5] Ref five.\n\n[6] Ref six.\n\n[7] Ref seven.\n`,
  'tm-numbered': `---\ntitle: "Numbered"\n---\n\n## Current view (reviewed 20 October 2026)\n\nNumbered view.\n\n## 6. Drug Interactions\n\nWarfarin [2].\n\n## 8. References\n\n1. Ref A.\n2. Ref B.\n`,
  // Leaves no room even for tm-master-long reduced (US-50 AC13).
  'tm-huge': `---\ntitle: "Huge"\n---\n\n${'h'.repeat(119_900)}\n`,
  'tm-master-long': `---\ntitle: "Long master"\n---\n\n## Current view (reviewed 20 October 2026)\n\nThe long master's view.\n\n## Evidence review\n\n${'r'.repeat(20_000)}\n`,
  'tm-article': `---\ntitle: "An article"\n---\n\n## Current view (reviewed 20 October 2026)\n\nNot a master.\n`,
};
const KEY_POINTS = '## Key safety points\n\n- May interact with warfarin [1].\n- Not for pregnant people [2].\n- Mild bloating is common [1, 2].';
files['tm-keyed'] = `---\ntitle: "Keyed"\n---\n\n## Current view (reviewed 20 October 2026)\n\nKeyed view.\n\n${KEY_POINTS}\n\n## 5. Safety and Side Effects\n\nFull safety text.\n\n## 6. Drug Interactions\n\nFull interactions text [3].\n\n## 9. References\n\n[1] Ref one.\n[2] Ref two.\n[3] Ref three.\n`;
files['tm-keylong'] = `---\ntitle: "Keylong"\n---\n\n## Current view (reviewed 20 October 2026)\n\nKeylong view.\n\n## Key safety points\n\n- ${'k'.repeat(1_500)} [1].\n\n## 6. Drug Interactions\n\nKeylong interactions.\n`;
const kpMaster = (name: string, kp: string) => `---\ntitle: "${name}"\n---\n\n## Current view (reviewed 20 October 2026)\n\n${name} view.\n\n${kp}\n\n## 6. Drug Interactions\n\n${name} interactions text.\n`;
files['tm-kp-head'] = kpMaster('KpHead', '## Key safety points');
files['tm-kp-tbw'] = kpMaster('KpTbw', '## Key safety points\n\nTo be written.');
files['tm-kp-rule'] = kpMaster('KpRule', '## Key safety points\n\n---\n\n- A bullet after the rule [1].');
files['tm-kp-indent'] = kpMaster('KpIndent', '## Key safety points\n\n  - One [1].\n\t* Two [1].\n   3. Three [1].');
files['tm-kp-summary'] = kpMaster('KpSummary', '## Key safety points (summary)\n\n- One [1].\n- Two [1].\n- Three [1].');
files['tm-kp-two'] = kpMaster('KpTwo', '## Key safety points\n\n- One [1].\n- Two [1].');
// Fourteen synthetic masters at realistic sizes, as the stack post
// (the-only-three-supplements-doctor-brad-takes) names once batch 3 lands: a
// ~1,800-character view, ~1,000-character key points carrying [n] markers, long
// reference lines, and whole safety sections far past the cap. The last stands
// in for vitamin K. Estimated 2026-10-21: views 1,233 to 2,449 characters (mean
// 1,823), reference lines median 258.
const STACK = 14;
const stackPoints = (i: number) => `## Key safety points\n\n- ${i === STACK - 1 ? 'Vitamin K may weaken warfarin; people on warfarin should ask their doctor first [1]. ' : ''}${String(i % 10).repeat(500)} [1].\n- Second point ${'b'.repeat(200)} [1, 2].\n- Third point ${'c'.repeat(150)} [2].`;
for (let i = 0; i < STACK; i++) {
  files[`tm-stack-${i}`] = `---\ntitle: "Stack ${i}"\nreviewed: "2026-10-20"\n---\n\n## Current view (reviewed 20 October 2026)\n\n${'v'.repeat(1_800)}\n\n${stackPoints(i)}\n\n## 5. Safety and Side Effects\n\nStack ${i} safety [1]. ${'s'.repeat(8_000)}\n\n## 6. Drug Interactions\n\nStack ${i} interactions [2]. ${'i'.repeat(5_000)}\n\n## 7. Dietary Sources\n\nFood.\n\n## 9. References\n\n[1] Stack ref ${i} ${'r'.repeat(600)}\n[2] Stack ref two ${i} ${'q'.repeat(600)}\n`;
}
const realRead = fs.readFileSync;
function fakeFiles() {
  vi.spyOn(fs, 'readFileSync').mockImplementation(((p: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const handle = path.basename(String(p), '.md');
    if (handle in files) return files[handle];
    return (realRead as (...a: unknown[]) => unknown)(p, ...rest);
  }) as typeof fs.readFileSync);
}
afterEach(() => { vi.restoreAllMocks(); });

describe('currentViewSection (US-50 AC6)', () => {
  it('takes the Current view section, heading to the next ## heading', () => {
    expect(currentViewSection(files['tm-collagen'])).toBe(VIEW.replace(/^## /, '### '));
  });

  it('takes a Current evidence position section the same way', () => {
    expect(currentViewSection(files['tm-nad'])).toBe("### Current evidence position\n\nAn evidence summary, not Brad's view.");
  });

  it('a master with neither section gives nothing', () => {
    expect(currentViewSection(files['tm-empty'])).toBeNull();
  });
});

describe('safetySections (US-50 AC6)', () => {
  it('is empty for a master with no safety section', () => {
    expect(safetySections(files['tm-nad'])).toEqual([]);
  });
});

// The six masters published on 2026-10-20: every one adds its view plus its
// "Safety and Side Effects" and "Drug Interactions" sections, within the caps.
describe('masterViews on the published masters (US-50 AC6)', () => {
  const MASTERS = [
    'collagen-benefits-best-forms-dosing-and-side-effects',
    'vitamin-k-benefits-forms-dosing-and-side-effects',
    'magnesium-benefits-best-forms-dosing',
    'taurine-benefits-forms-dosing-and-side-effects',
    'creatine-benefits-best-forms-dosing-and-side-effects',
    'vitamin-c-benefits-forms-dosing-and-side-effects',
  ];
  it.each(MASTERS)('%s adds its view, then its interaction and safety sections', (handle) => {
    const block = masterViews([handle], [])!;
    expect(block).not.toBeNull();
    const view = block.indexOf('### Current view (reviewed');
    const safety = block.search(/^### \d+\. Safety and Side Effects$/m);
    const interactions = block.search(/^### \d+\. Drug Interactions$/m);
    expect(view).toBeGreaterThan(-1);
    expect(interactions).toBeGreaterThan(view);
    expect(safety).toBeGreaterThan(interactions);
    expect(block).not.toMatch(/^### \d+\. (?:References|Overview|Recommended Dosing)/m);
    expect(block).not.toContain("Brad's videos on this topic");
    expect(block).toMatch(/^\[\d+\] .+/m); // a cited bibliography line came with the safety text
    expect(block.length).toBeLessThanOrEqual(MAX_MASTER_VIEW_CHARS + MASTER_VIEWS_HEADING.length + 2);
  });

});

// US-50 AC12: a master with key safety points adds its view and those points,
// uncapped, and never its whole safety sections; the cap governs only masters
// not yet retrofitted. With fourteen such masters, vitamin K's warfarin point
// always goes in.
describe('masterViews with key safety points (US-50 AC12)', () => {
  it('a retrofitted master adds its view and key points with the [n] markers stripped, no reference lines, no full safety sections', () => {
    fakeFiles();
    const block = masterViews(['tm-keyed'], [])!;
    expect(block).toContain(`title: Keyed\n\n### Current view (reviewed 20 October 2026)\n\nKeyed view.\n\n${KEY_POINTS.replace(/^## /, '### ').replace(/ ?\[\d+(?:, \d+)*\]/g, '')}`);
    expect(block).not.toMatch(/\[\d/);
    for (const text of ['Full safety text.', 'Full interactions text', 'Drug Interactions', 'Ref one.', 'Ref two.', 'Ref three.', 'References cited above']) expect(block).not.toContain(text);
  });

  it('an un-retrofitted master beside it still adds its whole interactions and safety sections under the cap', () => {
    fakeFiles();
    const block = masterViews(['tm-keyed', 'tm-safe'], [])!;
    expect(block).toContain('### Key safety points');
    expect(block).not.toContain('Full interactions text');
    const safe = block.slice(block.indexOf('title: Safe'));
    expect(safe).toContain('### 6. Drug Interactions\n\nMay interact with warfarin.');
    expect(safe.indexOf('### 6. Drug Interactions')).toBeLessThan(safe.indexOf('### 5. Safety and Side Effects'));
  });

  it('key points over 1,500 characters are dropped and logged, and the master falls back to its safety sections', () => {
    fakeFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(['tm-keylong'], [])!;
    expect(block).toContain('Keylong view.');
    expect(block).not.toContain('Key safety points');
    expect(block).toContain('### 6. Drug Interactions\n\nKeylong interactions.');
    expect(warn.mock.calls.map(([m]) => String(m))).toContain('YouTube master views: key safety points over 1500 characters, dropped: tm-keylong');
  });

  it('the stack post: fourteen views with key points, vitamin K keeps its warfarin point, no markers, no reference lines, no whole safety section, under 50,000', () => {
    fakeFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(Array.from({ length: STACK }, (_, i) => `tm-stack-${i}`), [])!;
    expect(block.match(/^### Current view \(reviewed/gm)).toHaveLength(STACK);
    expect(block.match(/^### Key safety points$/gm)).toHaveLength(STACK);
    expect(block.slice(block.indexOf(`title: Stack ${STACK - 1}`))).toContain('Vitamin K may weaken warfarin');
    for (const text of ['Drug Interactions', 'Safety and Side Effects', 'Food.']) expect(block).not.toContain(text);
    expect(block).not.toMatch(/\[\d/);
    for (const text of ['Stack ref', 'References cited above']) expect(block).not.toContain(text);
    expect(MAX_MASTER_VIEW_CHARS).toBe(80_000);
    expect(block.length).toBeGreaterThan(35_000); // views and key points are not trimmed
    expect(block.length).toBeLessThan(50_000);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each(['tm-kp-head', 'tm-kp-tbw', 'tm-kp-rule', 'tm-kp-two'])('%s: key points with fewer than 3 bullet lines are dropped, logged, and the master falls back to Drug Interactions (US-50 AC12)', (handle) => {
    fakeFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews([handle], [])!;
    expect(block).toContain('### 6. Drug Interactions');
    expect(block).not.toContain('Key safety points');
    expect(warn.mock.calls.map(([m]) => String(m))).toContain(`YouTube master views: key safety points malformed, dropped: ${handle}`);
  });

  it('indented and numbered bullets count at runtime, as in the checker', () => {
    fakeFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(['tm-kp-indent'], [])!;
    expect(block).toContain('### Key safety points');
    expect(block).not.toContain('Drug Interactions');
    expect(warn).not.toHaveBeenCalled();
  });

  it('the exact heading only: "## Key safety points (summary)" is not key points and the master falls back', () => {
    fakeFiles();
    const block = masterViews(['tm-kp-summary'], [])!;
    expect(block).not.toMatch(/^### Key safety points$/m);
    expect(block).toContain('### 6. Drug Interactions\n\nKpSummary interactions text.');
  });

  it('the runtime and the batch checker share the 1,500-character key-points limit, and the checker ends the section at a rule too', () => {
    expect(MAX_KEY_POINTS_CHARS).toBe(CHECKER_MAX_KEY_POINTS_CHARS);
    expect(BULLET_LINE.source).toBe(CHECKER_BULLET_LINE.source);
    expect(BULLET_LINE.flags).toBe(CHECKER_BULLET_LINE.flags);
    const body = (kp: string) => `## Current view (reviewed 20 October 2026)\n\nView.\n\n${kp}\n\n## 9. References\n\n[1] Ref one.\n`;
    expect(keySafetyErrors(body('## Key safety points\n\n- A [1].\n- B [1].\n- C [1].'))).toEqual([]);
    expect(keySafetyErrors(body('## Key safety points\n\n  - A [1].\n\t* B [1].\n   3. C [1].'))).toEqual([]);
    expect(keySafetyErrors(body('## Key safety points\n\n- A [1].\n- B [1].\n\n---\n\n- C [1].')).join()).toContain('2 bullets');
  });
});

// US-50 AC6, AC12: the real stack post names fourteen real masters, none with key points yet, so
// each competes under the cap with its whole safety sections. Every one of
// their Drug Interactions sections must go in whole, vitamin K's warfarin line included.
describe('masterViews on the real stack post and the real masters (US-50 AC6, AC12)', () => {
  it('each named master adds its key points when they are sound, else its whole Drug Interactions section; nothing is skipped for the cap', () => {
    const post = fs.readFileSync('docs/blog/the-only-three-supplements-doctor-brad-takes.md', 'utf-8');
    const topics: string[] = JSON.parse(post.match(/^topics: (\[.*\])$/m)![1]);
    expect(topics.length).toBeGreaterThanOrEqual(14);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(topics, [])!;
    const soundPoints = (md: string) => {
      const kp = md.match(/^## Key safety points[ \t]*$[\s\S]*?(?=^## |^---\s*$|(?![\s\S]))/m)?.[0].trim();
      return kp && kp.length <= MAX_KEY_POINTS_CHARS && kp.split('\n').filter(l => BULLET_LINE.test(l)).length >= 3 ? kp : null;
    };
    let withView = 0;
    for (const handle of topics) {
      const md = fs.readFileSync(`docs/blog/${handle}.md`, 'utf-8');
      if (!currentViewSection(md)) continue;
      withView++;
      const kp = soundPoints(md);
      const ix = safetySections(md).filter(s => /^#+ .*\binteractions?\b/i.test(s));
      if (kp) {
        expect(block, handle).toContain(kp.replace(/^## /, '### ').replace(/ ?\[\d+(?:\s*[,–-]\s*\d+)*\]/g, ''));
        for (const s of ix) expect(block, handle).not.toContain(s);
      } else {
        expect(ix.length, handle).toBeGreaterThan(0);
        for (const s of ix) expect(block, handle).toContain(s);
      }
    }
    expect(withView).toBeGreaterThanOrEqual(8);
    // Vitamin K's warfarin warning, through whichever path applies to it.
    const vitK = fs.readFileSync('docs/blog/vitamin-k-benefits-forms-dosing-and-side-effects.md', 'utf-8');
    const vitKPoints = soundPoints(vitK);
    if (vitKPoints) expect(vitKPoints).toMatch(/warfarin/i);
    else expect(block).toContain('Vitamin K may reduce the effectiveness of warfarin.');
    expect(block.length).toBeLessThanOrEqual(MAX_MASTER_VIEW_CHARS + MASTER_VIEWS_HEADING.length + 2);
    expect(warn.mock.calls.map(([m]) => String(m)).filter(m => /interactions/i.test(m))).toEqual([]);
  });
});

describe('masterViews (US-50 AC6)', () => {
  it('adds each named master\'s section under its own label and header, in topics order', () => {
    fakeFiles();
    const block = masterViews(['tm-collagen', 'tm-nad', 'tm-empty'], [])!;
    expect(block.startsWith(`${MASTER_VIEWS_HEADING}\n\n[reference — reviewed 2026-10-20]\ntitle: Collagen\n\n### Current view`)).toBe(true);
    expect(block).toContain('[reference — published 2024-01-01]\ntitle: NAD\n\n### Current evidence position');
    expect(block.indexOf('Collagen peptides')).toBeLessThan(block.indexOf('An evidence summary'));
    expect(block).not.toContain('Evidence review');
    expect(block).not.toContain("Brad's videos");
  });

  it('skips a master the router already loaded, a repeat, a missing handle and a non-reference', () => {
    fakeFiles();
    const block = masterViews(['tm-collagen', 'tm-nad', 'tm-nad', 'no-such-master', 'tm-article'], ['tm-collagen'])!;
    expect(block).not.toContain('Collagen peptides');
    expect(block.match(/An evidence summary/g)).toHaveLength(1);
    expect(block).not.toContain('Not a master');
  });

  it('a view stops at a "---" line; a view over 6,000 characters (oversize, or a malformed master with no later heading) is dropped and logged (US-50 AC6)', () => {
    fakeFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(['tm-big', 'tm-malformed', 'tm-rule', 'tm-collagen'], [])!;
    expect(block).not.toContain('xxxx');
    expect(block).not.toContain('Malformed view.');
    expect(block).toContain('Rule view.');
    expect(block).not.toContain('Text after the rule.');
    expect(block).toContain('Collagen peptides');
    const logged = warn.mock.calls.map(([m]) => String(m));
    expect(logged).toContain('YouTube master views: current view over 6000 characters, dropped: tm-big');
    expect(logged).toContain('YouTube master views: current view over 6000 characters, dropped: tm-malformed');
  });

  it('per master, Drug Interactions goes in before Safety; Safety is never added when Interactions was skipped (US-50 AC6)', () => {
    fakeFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(['tm-mid1', 'tm-ix'], [])!;
    expect(block).toContain('Ix view.');
    expect(block).not.toContain('iiii');
    expect(block).not.toContain('Ix small safety.');
    const logged = warn.mock.calls.map(([m]) => String(m));
    expect(logged).toContain('YouTube master views: safety section skipped for the cap: tm-ix "## 6. Drug Interactions"');
    expect(logged).toContain('YouTube master views: safety section skipped for the cap: tm-ix "## 5. Safety and Side Effects"');
    const alone = masterViews(['tm-safe'], [])!;
    expect(alone.indexOf('### 6. Drug Interactions')).toBeLessThan(alone.indexOf('### 5. Safety and Side Effects'));
  });

  it('every view goes in first; a safety section that would pass the total cap is skipped and logged (US-50 AC6)', () => {
    fakeFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(['tm-mid1', 'tm-mid2', 'tm-collagen'], [])!;
    for (const view of ['Mid one.', 'Mid two.', 'Collagen peptides']) expect(block).toContain(view);
    expect(block).toContain('1111');
    expect(block).not.toContain('2222');
    expect(block.length).toBeLessThanOrEqual(MAX_MASTER_VIEW_CHARS + MASTER_VIEWS_HEADING.length + 2);
    const logged = warn.mock.calls.map(([m]) => String(m));
    expect(logged).toContain('YouTube master views: safety section skipped for the cap: tm-mid2 "## Safety"');
    expect(logged.some(m => m.includes('tm-mid1'))).toBe(false);
  });

  it('two masters with identical safety text: each section is counted as rendered, so the block stays within the cap (US-50 AC6)', () => {
    fakeFiles();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(['tm-dup1', 'tm-dup2'], [])!;
    expect(block.match(/^### Safety$/gm)).toHaveLength(1);
    expect(block.length).toBeLessThanOrEqual(MAX_MASTER_VIEW_CHARS + MASTER_VIEWS_HEADING.length + 2);
    expect(warn.mock.calls.map(([m]) => String(m))).toContain('YouTube master views: safety section skipped for the cap: tm-dup2 "## Safety"');
  });

  it('a safety section brings the bibliography lines its [n] markers cite, and only those (US-50 AC6)', () => {
    fakeFiles();
    const block = masterViews(['tm-cited', 'tm-numbered'], [])!;
    for (const line of ['[2] Ref two.', '[3] Ref three.', '[5] Ref five.', '[6] Ref six.', '[7] Ref seven.', '[2] Ref B.']) expect(block).toContain(line);
    for (const line of ['Ref one.', 'Ref four.', 'Ref A.']) expect(block).not.toContain(line);
    expect(block.indexOf('[2] Ref two.')).toBeGreaterThan(block.indexOf('Rare rash [2].'));
  });

  it('adds the safety, side-effect, caution, interaction and who-should-not sections after the view (US-50 AC6)', () => {
    fakeFiles();
    const block = masterViews(['tm-safe'], [])!;
    expect(block).toContain('### Current view');
    for (const text of ['### 5. Safety and Side Effects', '#### Common Side Effects', 'Mild bloating.', '### 6. Drug Interactions', 'May interact with warfarin.', '### Cautions', '### Who Should Not Take It', 'Pregnant people.']) {
      expect(block).toContain(text);
      expect(block.indexOf(text)).toBeGreaterThan(block.indexOf('Safe view.'));
    }
    for (const text of ['Benefits.', 'Food.', 'Most adults.']) expect(block).not.toContain(text);
  });

  it('no topics, or nothing to add, gives null', () => {
    fakeFiles();
    expect(masterViews(undefined, [])).toBeNull();
    expect(masterViews(['tm-empty'], [])).toBeNull();
  });
});

describe('runPipeline: the reply-or-skip input (US-50 AC6)', () => {
  const thread = { topLevelCommentId: 'c1', videoId: 'vid1', authorDisplayName: 'V', authorChannelId: null, text: 'Is collagen still worth taking for skin?', publishedAt: '2026-10-20T00:00:00Z' };
  const entry = { title: 'Old collagen video', handle: 'old-collagen', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z', topics: ['tm-collagen'] };

  function systemOf(): string[] {
    const blocks = vi.mocked(getChatCompletion).mock.calls.at(-1)![0] as Array<{ text: string }>;
    return blocks.map(b => b.text);
  }

  it('with no router match, the master view is loaded but no Referenced Blog Articles block exists', async () => {
    fakeFiles();
    await runPipeline(thread, entry, 'The video body.');
    const texts = systemOf();
    expect(texts.some(t => t.startsWith('## Referenced Blog Articles'))).toBe(false);
    const platform = texts.find(t => t.includes('The video body.'))!;
    // The prompt names the heading in its rules; the block itself is the heading then a header.
    expect(platform.indexOf(`${MASTER_VIEWS_HEADING}\n\n[reference`)).toBeGreaterThan(platform.indexOf('The video body.'));
    expect(platform).toContain('Collagen peptides may improve skin hydration');
  });

  it('the video post\'s publish date and the master\'s reviewed date both reach the model (Codex R1)', async () => {
    fakeFiles();
    await runPipeline(thread, entry, 'The video body.');
    const platform = systemOf().find(t => t.includes('The video body.'))!;
    expect(platform).toContain('Published: 2025-03-12');
    expect(platform).toContain('[reference — reviewed 2026-10-20]');
  });

  it('a master the router picked but the cap skipped, even reduced, still adds its current view (H2, Codex R2; US-50 AC13)', async () => {
    fakeFiles();
    vi.mocked(routeQuery).mockResolvedValueOnce({ handles: ['tm-huge', 'tm-master-long'], rawJson: null, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null });
    await runPipeline(thread, { ...entry, topics: ['tm-master-long'] }, 'The video body.');
    const texts = systemOf();
    const articles = texts.find(t => t.startsWith('## Referenced Blog Articles'))!;
    expect(articles).toContain('hhhh');
    expect(articles).not.toContain("The long master's view.");
    expect(texts.join('\n')).toContain(`${MASTER_VIEWS_HEADING}\n\n[reference — reviewed 2026-10-20]\ntitle: Long master\n\n### Current view (reviewed 20 October 2026)\n\nThe long master's view.`);
  });

  // H3 (pre-registered, not run here): a paid dry run of an off-topic comment
  // (camera question) on a video whose post names a master must still return
  // SKIP_NO_REPLY. The harness has no YouTube fixture type, so the check is run
  // with tools/youtube-comment-dryrun.ts; this test pins its input: the master
  // view is present and no router-matched block exists.
  it('an off-topic comment gets the master view but no router-matched block (H3 skip input)', async () => {
    fakeFiles();
    await runPipeline({ ...thread, text: 'Love the lighting in this video, what camera do you use for filming?' }, entry, 'The video body.');
    const texts = systemOf();
    expect(texts.some(t => t.startsWith('## Referenced Blog Articles'))).toBe(false);
    expect(texts.join('\n')).toContain(`${MASTER_VIEWS_HEADING}\n\n[reference`);
  });

  it('a master the router picked loads once, as router-matched content', async () => {
    fakeFiles();
    vi.mocked(routeQuery).mockResolvedValueOnce({ handles: ['tm-collagen'], rawJson: null, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null });
    await runPipeline(thread, entry, 'The video body.');
    const texts = systemOf();
    expect(texts.find(t => t.startsWith('## Referenced Blog Articles'))).toContain('Collagen peptides');
    expect(texts.join('\n')).not.toContain(`${MASTER_VIEWS_HEADING}\n\n[reference`);
  });
});

// US-50 AC11: the assembled YouTube and Discord prompts both carry the omega-3
// affiliate disclosure; on YouTube it is exempt from the do-not-copy rule and
// the length limits.
describe('omega-3 affiliate disclosure in the assembled platform prompts (US-50 AC11)', () => {
  const DISCLOSURE = 'Brad earns a small commission through this Amazon link.';
  const lastSystem = () => (vi.mocked(getChatCompletion).mock.calls.at(-1)![0] as Array<{ text: string }>).map(b => b.text).join('\n\n');

  it('YouTube: the reply rule names the exact sentence and its exemptions', async () => {
    fakeFiles();
    await runPipeline({ topLevelCommentId: 'c9', videoId: 'vid9', authorDisplayName: 'V', authorChannelId: null, text: 'Which fish oil does Brad take?', publishedAt: '2026-10-20T00:00:00Z' },
      { title: 'Omega-3 video', handle: 'omega-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z' }, 'The video body.');
    const prompt = lastSystem();
    expect(prompt).toContain(`- **Omega-3 affiliate disclosure:** when a reply shares the omega-3 Amazon link, it must include this exact sentence: "${DISCLOSURE}" This sentence is exempt from the do-not-copy rule above and does not count toward the sentence or word limits.`);
    expect(prompt).toContain(`say: "${DISCLOSURE}"`);
  });

  it('Discord: the doctor posture and system prompt carry the disclosure', async () => {
    await platformChatCompletion({ message: 'Which fish oil does Brad take?', history: [] });
    const prompt = lastSystem();
    expect(prompt).toContain('Platform: Discord');
    expect(prompt).toContain(`- **One exception, omega-3:**`);
    expect(prompt).toContain(`say: "${DISCLOSURE}"`);
  });
});

// US-50 AC6: the dry-run preview builds its context through the bot's function,
// so it adds master views too. It is a paid script, so this checks its source.
describe('youtube-comment-dryrun shares the context builder (US-50 AC6)', () => {
  const src = fs.readFileSync('tools/youtube-comment-dryrun.ts', 'utf-8');
  it('imports buildYouTubePlatformContext from youtube-context and keeps no copy', () => {
    expect(src).toMatch(/import \{[^}]*\bbuildYouTubePlatformContext\b[^}]*\} from '\.\.\/app\/lib\/youtube-context'/);
    expect(src).not.toMatch(/function buildYouTubePlatformContext/);
    expect(src).not.toContain('chat-youtube-prompt.md');
  });
  it('passes the loaded handles, so master views are de-duplicated as in the bot', () => {
    expect(src).toContain('buildYouTubePlatformContext(VIDEO_ID, blogPost.entry, blogPost.body, loadedHandles(matchedHandles,');
  });
});

// US-50 AC3: the dry run routes through the production router view and index
// block, so it hides exactly what production hides, and states the view's count.
describe('youtube-comment-dryrun uses the router view (US-50 AC3)', () => {
  const src = fs.readFileSync('tools/youtube-comment-dryrun.ts', 'utf-8');
  it('builds its allow-list, index block and entry count from routerView', () => {
    expect(src).toMatch(/import \{[^}]*\brouterView\b[^}]*\brouterIndexBlock\b[^}]*\} from '\.\.\/app\/lib\/router-view'/);
    expect(src).toContain('routerView(loadBlogIndex())');
    expect(src).toContain('routerIndexBlock(ROUTER_VIEW)');
    expect(src).toContain('.replace(/\\{\\{ENTRY_COUNT\\}\\}/g, String(ROUTER_VIEW.length))');
    expect(src).not.toContain('TYPE_ORDER');
    expect(src).not.toContain('# KB Index');
  });
});

// US-50 AC13 (R6): the chat's reduced form applies masterViews' malformed-view
// rule, so a view over MAX_VIEW_CHARS never reaches the model by that path either.
describe('reducedMaster keeps the malformed-view check (US-50 AC13)', () => {
  it('drops a view over MAX_VIEW_CHARS and keeps the safety sections with their reference lines', () => {
    const md = `---\ntitle: "X"\nreviewed: "2026-10-20"\n---\n\n## Current view (reviewed 20 October 2026)\n\n${'v'.repeat(MAX_VIEW_CHARS)}\n\n## 5. Safety and Side Effects\n\nSafe [1].\n\n## 8. References\n\n[1] A ref.\n`;
    const reduced = reducedMaster(md)!;
    expect(reduced).not.toContain('vvv');
    expect(reduced).toContain('Safe [1].');
    expect(reduced).toMatch(/^\[1\] A ref\.$/m);
  });
});
