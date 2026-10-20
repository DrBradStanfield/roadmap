/**
 * US-50 AC5 and AC6: the prompt clauses that make the block headers and the
 * YouTube master views mean something. Static checks only; the answer
 * fixtures (tools/test-queries.json, category "topic-masters") are the
 * behavioural check, run by the orchestrator under the harness-spend rules.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase.server', () => ({ supabaseAdmin: null }));

import { MASTER_VIEWS_HEADING } from './youtube-context';
import { loadBlogIndex } from './blog-index.server';

const system = readFileSync('app/lib/chat-system-prompt.md', 'utf-8');
const youtube = readFileSync('app/lib/chat-youtube-prompt.md', 'utf-8');
const section = (md: string, heading: string) => md.slice(md.indexOf(heading), md.indexOf('\n### ', md.indexOf(heading) + 1));

describe('answer prompt precedence (US-50 AC5)', () => {
  const loaded = section(system, '### On loaded reference content');

  it('sits in the loaded-reference section, keeps it supplementary, and uses the neutral header label', () => {
    expect(loaded).toContain('the loaded content is supplementary, not authoritative');
    expect(loaded).toContain('[reference — reviewed 2026-10-20]');
    expect(loaded).toContain('[video post — published 2025-03-12]');
    expect(system).not.toContain('current view reviewed');
  });

  it('this prompt, PRODUCTS and the ANSWER BANK outrank every loaded block (M3)', () => {
    expect(loaded).toContain('This prompt (including the research and product claims rules), the PRODUCTS section and the ANSWER BANK outrank every loaded block.');
  });

  it('states the newer-post rule once, in the N2 sentence', () => {
    // The N2 sentence is the single statement of the rule (Codex, merged branch: no repeat).
    expect(loaded).not.toContain('Among loaded blocks, a reference');
    expect(loaded).not.toContain('A loaded post or video published after that reviewed date wins');
  });

  it('the "view has changed" trigger is scoped to a Current view against a video post (N2)', () => {
    expect(loaded).toContain("When a reference's Current view and a loaded video post differ, the more recent one wins: a post published after the reference's reviewed date may record a newer view; otherwise the Current view wins. On the doctor surfaces, say plainly that Brad's view has changed and what it is now; on the brand surface, state the current position in your own voice. A reference's Current evidence position is never Brad's view, so it never prompts a 'view has changed' remark. A post dated the same day as the reviewed date counts as covered by the Current view.");
    expect(loaded).not.toContain('When loaded blocks differ');
  });

  it('the whose-view rule is scoped to references and leaves posts and the answer bank to "Brad\'s stated views" (B1)', () => {
    expect(loaded).toContain("Within a reference entry, only sentences in its Current view section that cite one of Brad's posts are Brad's view; its other sections and any Current evidence position are evidence summaries.");
    expect(loaded).toContain('Brad\'s posts and the ANSWER BANK follow "Brad\'s stated views" above.');
    expect(loaded).not.toContain('the brand surface never attributes any of them to Brad'); // N6: the brand posture governs
    expect(system).toContain("Either quote Brad's loaded blog/script content directly (on the doctor surfaces an ANSWER BANK entry also counts as a record of Brad's view)");
    expect(loaded).not.toMatch(/^- \*\*Whose view\.\*\* Only sentences/m);
  });

  it('keeps the collagen and nitric-oxide rules', () => {
    expect(system).toContain('- **Nitric oxide:** MicroVitamin and MicroVitamin+ are not nitric-oxide products');
    expect(system).toContain('- **Collagen and skin:** for a concern about skin ageing');
  });
});

describe('YouTube prompt and the master views (US-50 AC6)', () => {
  it('names the exact heading the bot adds', () => {
    expect(youtube).toContain(`**The "${MASTER_VIEWS_HEADING}" section never counts here.**`);
    expect(youtube).toContain(`3. **"${MASTER_VIEWS_HEADING}"**`);
  });

  it('the reply-or-skip rule ignores the section', () => {
    expect(youtube).toContain('Ignore it in Step 1 and Step 2: decide between Output A and Output B exactly as you would without it.');
  });

  it('gives the video its publish date, to compare with the reviewed date (Codex R1)', () => {
    expect(youtube).toContain('Published: {{VIDEO_PUBLISHED}}');
  });

  it("the more recent of video and Current view wins, scoped as in the answer prompt (N2)", () => {
    expect(youtube).toContain("When a topic page's Current view and this video differ, the more recent one wins: if the video was published after the page's reviewed date, the video may record a newer view, so give the video's view and say plainly that it is Brad's newer position; otherwise the Current view wins");
    expect(youtube).toContain('a video dated the same day as the reviewed date counts as covered by the Current view');
    expect(youtube).toContain('A Current evidence position is never Brad\'s view, so it never prompts a "view has changed" remark.');
  });

  it('the safety sections are evidence summaries, never Brad\'s view (US-50 AC6)', () => {
    expect(youtube).toContain("followed by that page's safety, side-effect and drug-interaction sections. Those safety sections are evidence summaries, never Brad's view; use them when a reply touches safety, side effects or interactions.");
    expect(MASTER_VIEWS_HEADING).toContain('current view and safety notes');
  });

  it('states the two-axis rule and allows a public "view has changed"', () => {
    expect(youtube).toContain("The video's content is the authority on what the video said; this section is the authority on Brad's view today.");
    expect(youtube).toContain("a reply may say publicly that Brad's view has changed since the video");
  });
});

// US-50 AC11: Brad's omega-3 brand (products.md) on the doctor surfaces only;
// the brand posture never presents Brad's routine as an endorsement.
describe('omega-3 brand (US-50 AC11)', () => {
  const brand = readFileSync('app/lib/chat-posture-brand.md', 'utf-8');
  const products = readFileSync('docs/products.md', 'utf-8');
  it('the doctor surfaces share WHC UnoCardio 1000 and its link; the brand surface gives criteria only', () => {
    expect(system).toContain("On the doctor surfaces, when a user asks which omega-3 Brad takes or which one to buy, also say that the brand he takes himself and recommends is WHC UnoCardio 1000 Fish Oil, with its Amazon link from the PRODUCTS section. On the brand surface, Brad's personal routine is never an endorsement: give the criteria only, with no brand name or link.");
    expect(system).toContain('describe the ingredient criteria (a fish-oil providing meaningful EPA/DHA per serving)');
    expect(system).toContain('Dr. Stanfield does not sell an Omega-3 product.');
    expect(system).not.toContain('do not link a specific branded product');
    expect(products).toContain('**WHC UnoCardio 1000 Fish Oil**, available on Amazon: https://amzn.to/');
    expect(brand).toContain('do not present Brad\'s personal routine as an endorsement');
  });
});

// US-50 AC5 (H3): pre-registered answer fixtures. Not run here: no paid runs.
describe('topic-masters answer fixtures are registered (US-50 AC5)', () => {
  interface Fixture { query: string; category: string; surface?: string; answer_handles?: string[]; expected?: string[]; must_mention?: string[]; must_not_mention?: string[]; must_match?: string[]; must_not_match?: string[] }
  const all = JSON.parse(readFileSync('tools/test-queries.json', 'utf-8')) as Fixture[];
  const fixtures = all.filter(q => q.category === 'topic-masters');
  const handles = new Set(loadBlogIndex().map(e => e.handle));

  it('covers master vs older post, newer post, evidence position and the brand surface', () => {
    expect(fixtures).toHaveLength(4);
    expect(new Set(fixtures.map(q => q.surface))).toEqual(new Set(['doctor', 'brand']));
  });

  // The harness lower-cases the answer before matching (Codex, merged branch).
  it('the saffron fixture lets the required disclaimer through and catches attribution', () => {
    const saffron = fixtures.find(q => q.answer_handles?.includes('saffron-benefits-forms-dosing-and-side-effects'))!;
    const hits = (text: string) => (saffron.must_not_match ?? []).some(r => new RegExp(r).test(text.toLowerCase()));
    expect(hits("There's no record of Brad making a specific statement on saffron.")).toBe(false);
    expect(hits('Brad has no recorded position on saffron. The evidence suggests it may help mild low mood.')).toBe(false);
    expect(hits('Brad recommends saffron for low mood.')).toBe(true);
    expect(hits("Dr Stanfield's view is that saffron works.")).toBe(true);
    expect(hits('He recommends 30 mg a day.')).toBe(true);
  });

  it('each is a fixed-handle answer check on real handles with answer rules that compile', () => {
    for (const q of fixtures) {
      expect(q.expected, q.query).toBeUndefined();
      expect(q.answer_handles!.length, q.query).toBeGreaterThan(0);
      for (const h of q.answer_handles!) expect(handles.has(h), h).toBe(true);
      expect((q.must_mention?.length ?? 0) + (q.must_not_mention?.length ?? 0) + (q.must_match?.length ?? 0) + (q.must_not_match?.length ?? 0), q.query).toBeGreaterThan(0);
      for (const r of [...(q.must_match ?? []), ...(q.must_not_match ?? [])]) expect(() => new RegExp(r)).not.toThrow();
    }
  });
});
