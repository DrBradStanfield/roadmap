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

  it('the current view outranks an older post; a newer post wins over the current view', () => {
    expect(loaded).toContain('a reference\'s "Current view" section outranks any loaded post or video published before the reference\'s reviewed date');
    expect(loaded).toContain('A loaded post or video published after that reviewed date wins over the current view: it may record a change of view the reference has not caught up with.');
    expect(loaded).toContain('say plainly that the position has changed since the older post');
  });

  it('attributes the change to Brad on doctor surfaces only; the brand surface uses its own voice (H1)', () => {
    expect(loaded).toContain("On the doctor surfaces, say that Brad's view has changed, or that the newer post is Brad's latest position.");
    expect(loaded).toContain('On the brand surface, state the current position in your own voice and never attribute it to Brad.');
  });

  it('the whose-view rule is scoped to references and leaves posts and the answer bank to "Brad\'s stated views" (B1)', () => {
    expect(loaded).toContain("Within a reference entry, only sentences in its Current view section that cite one of Brad's posts are Brad's view; its other sections and any Current evidence position are evidence summaries.");
    expect(loaded).toContain('Brad\'s posts and the ANSWER BANK follow "Brad\'s stated views" above');
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

  it("a video published after the reviewed date wins on Brad's view today", () => {
    expect(youtube).toContain("If this video was published after the section's reviewed date, the video wins: it may record a change of view the topic page has not caught up with, so give the video's view and say plainly that it is Brad's newer position.");
  });

  it('states the two-axis rule and allows a public "view has changed"', () => {
    expect(youtube).toContain("The video's content is the authority on what the video said; this section is the authority on Brad's view today.");
    expect(youtube).toContain("a reply may say publicly that Brad's view has changed since the video");
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
