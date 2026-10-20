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
    ref('tm-safe'), ref('tm-mid1'), ref('tm-mid2'), ref('tm-cited'), ref('tm-numbered'), ref('tm-malformed'), ref('tm-rule'), ref('tm-ix'),
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
import { currentViewSection, safetySections, masterViews, MASTER_VIEWS_HEADING, MAX_MASTER_VIEW_CHARS } from './youtube-context';
import { getChatCompletion } from './chat.server';
import { loadBlogIndex } from './blog-index.server';
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
  'tm-cited': `---\ntitle: "Cited"\n---\n\n## Current view (reviewed 20 October 2026)\n\nCited view [1].\n\n## 3. Evidence\n\nBenefit [1].\n\n## 5. Safety and Side Effects\n\nRare rash [2]. Liver note [3, 5]. Range [6–7]. A DOI link [10.1000/xyz].\n\n## 9. References\n\n[1] Ref one.\n\n[2] Ref two.\n\n[3] Ref three.\n\n[4] Ref four.\n\n[5] Ref five.\n\n[6] Ref six.\n\n[7] Ref seven.\n`,
  'tm-numbered': `---\ntitle: "Numbered"\n---\n\n## Current view (reviewed 20 October 2026)\n\nNumbered view.\n\n## 6. Drug Interactions\n\nWarfarin [2].\n\n## 8. References\n\n1. Ref A.\n2. Ref B.\n`,
  'tm-huge': `---\ntitle: "Huge"\n---\n\n${'h'.repeat(110_000)}\n`,
  'tm-master-long': `---\ntitle: "Long master"\n---\n\n## Current view (reviewed 20 October 2026)\n\nThe long master's view.\n\n## Evidence review\n\n${'r'.repeat(20_000)}\n`,
  'tm-article': `---\ntitle: "An article"\n---\n\n## Current view (reviewed 20 October 2026)\n\nNot a master.\n`,
};
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

  // A post naming five reviewed masters (collagen, creatine, magnesium, taurine,
  // vitamin K): every view goes in, safety sections fill the rest of the cap,
  // and each one skipped for the cap is logged with its handle.
  it('the-only-three-supplements-doctor-brad-takes: every master view, then safety within the total cap', () => {
    const entry = loadBlogIndex().find(e => e.handle === 'the-only-three-supplements-doctor-brad-takes')!;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const block = masterViews(entry.topics, [])!;
    const views = block.match(/^### Current view \(reviewed/gm) ?? [];
    // One view per named master that has a Current view (grows as masters are rewritten).
    const withView = entry.topics!.filter(h => /^## Current view \(reviewed/m.test((fs.existsSync(path.join(process.cwd(), 'docs/blog', `${h}.md`)) ? fs.readFileSync(path.join(process.cwd(), 'docs/blog', `${h}.md`), 'utf-8') : '')));
    expect(withView.length).toBeGreaterThanOrEqual(5);
    expect(views).toHaveLength(withView.length);
    expect(block.length).toBeLessThanOrEqual(MAX_MASTER_VIEW_CHARS + MASTER_VIEWS_HEADING.length + 2);
    expect(block).toMatch(/^### \d+\. Safety and Side Effects$/m);
    // Vitamin K's interactions (warfarin) outrank every master's side effects.
    const vitK = block.slice(block.indexOf('title: Vitamin K'));
    expect(vitK).toMatch(/^### \d+\. Drug Interactions$/m);
    expect(vitK).toContain('Warfarin');
    for (const [msg] of warn.mock.calls) expect(String(msg)).toMatch(/^YouTube master views: safety section skipped for the cap: [a-z0-9-]+ /);
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

  it('a master the router picked but the cap skipped still adds its current view (H2, Codex R2)', async () => {
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
