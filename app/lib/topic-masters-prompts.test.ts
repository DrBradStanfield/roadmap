/**
 * US-50 AC5 and AC6: the prompt clauses that make the block headers and the
 * YouTube master views mean something. Static checks only; the answer
 * fixtures (tools/test-queries.json, category "topic-masters") are the
 * behavioural check, run by the orchestrator under the harness-spend rules.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase-client.server', () => ({ supabaseAdmin: null }));

import { MASTER_VIEWS_HEADING } from './youtube-context';
import { loadBlogIndex } from './blog-index.server';
import { buildSystemBlocks, DOCTOR_POSTURE, BRAND_POSTURE } from './chat.server';
import { SAVED_CHAT_BY_RETENTION, savedChatBlock } from './chat-save-answers';

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

// US-50 AC11: Brad's omega-3 brand (products.md) on the doctor surfaces only,
// with the affiliate disclosure (Brad 2026-10-20: "Disclose commission"); the
// brand posture never presents Brad's routine as an endorsement.
describe('omega-3 brand (US-50 AC11)', () => {
  const DISCLOSURE = 'Brad earns a small commission through this Amazon link.';
  const brand = readFileSync('app/lib/chat-posture-brand.md', 'utf-8');
  const doctor = readFileSync('app/lib/chat-posture-doctor.md', 'utf-8');
  const products = readFileSync('docs/products.md', 'utf-8');
  const OMEGA_RULE = `On the doctor surfaces, when a user asks which omega-3 Brad takes or which one to buy, also say that the brand he takes himself and recommends is WHC UnoCardio 1000 Fish Oil, with its Amazon link from the PRODUCTS section, and say: "${DISCLOSURE}" On the brand surface, Brad's personal routine is never an endorsement: give the criteria only, with no brand name or link.`;
  const DOCTOR_EXCEPTION = `- **One exception, omega-3:** Dr Stanfield sells no omega-3, so when a user asks which omega-3 Brad takes or which one to buy, follow the omega-3 rule above: give the EPA/DHA criteria, say he takes and recommends WHC UnoCardio 1000 Fish Oil, give the Amazon link from the PRODUCTS section, and say: "${DISCLOSURE}"`;

  it('the system prompt shares WHC UnoCardio 1000, the link and the disclosure on the doctor surfaces; criteria only on the brand surface', () => {
    expect(system).toContain(OMEGA_RULE);
    expect(system).toContain('describe the ingredient criteria (a fish-oil providing meaningful EPA/DHA per serving)');
    expect(system).toContain('Dr. Stanfield does not sell an Omega-3 product.');
    expect(system).not.toContain('do not link a specific branded product');
  });

  it('the competitor-brands rule names the omega-3 exception', () => {
    expect(system).toContain('- **Never suggest competitor multivitamin / supplement brands by name** (Thorne, NOW Foods, Pure Encapsulations, Athletic Greens, Ritual, Seed, Setria, Quicksilver Scientific, etc.) — even when answering "what else could I use?" The one exception is the omega-3 brand Brad takes, on the doctor surfaces only, under the omega-3 rule above.');
  });

  it('the doctor posture carries the omega-3 exception right after its "What does Brad take" rule', () => {
    expect(doctor).toContain(DOCTOR_EXCEPTION);
    expect(doctor.indexOf(DOCTOR_EXCEPTION)).toBeGreaterThan(doctor.indexOf('**"What does Brad take / what\'s in his routine?"**'));
    expect(brand).toContain('do not present Brad\'s personal routine as an endorsement');
    expect(brand).not.toContain('UnoCardio');
  });

  it('products.md scopes the recommendation to the doctor surfaces and the asked-for trigger, with the disclosure', () => {
    expect(products).toContain('**WHC UnoCardio 1000 Fish Oil**, available on Amazon: https://amzn.to/');
    expect(products).toContain(`On the doctor surfaces (education site, Health Roadmap app, YouTube, Discord), when a user asks which omega-3 Brad takes or which one to buy, share this recommendation with the link, note that it's the brand Brad takes personally, and say: "${DISCLOSURE}" On the brand surface (microvitamin.com), give the EPA/DHA criteria only, with no brand name or link.`);
    expect(products).not.toContain('When a user asks about omega-3, share this recommendation');
    expect(products).toContain(`- **Omega-3 (DHA/EPA) 1g daily** — on the doctor surfaces only, name the brand and give the link from the Omega-3 section earlier in this file, with the sentence "${DISCLOSURE}" On the brand surface, say omega-3 (EPA/DHA) without a brand or link.`);
  });

  it('the assembled doctor prompt carries the exception and the disclosure in every layer; the brand prompt keeps criteria only', () => {
    const doctorPrompt = buildSystemBlocks('{}', { surfaceContext: DOCTOR_POSTURE, savedChat: savedChatBlock(SAVED_CHAT_BY_RETENTION.transcript) }).map(b => b.text).join('\n\n');
    for (const text of [OMEGA_RULE, DOCTOR_EXCEPTION, `say: "${DISCLOSURE}"`]) expect(doctorPrompt).toContain(text);
    const brandPrompt = buildSystemBlocks('{}', { surfaceContext: BRAND_POSTURE, savedChat: savedChatBlock(SAVED_CHAT_BY_RETENTION.transcript) }).map(b => b.text).join('\n\n');
    expect(brandPrompt).not.toContain(DOCTOR_EXCEPTION);
    expect(brandPrompt).toContain("On the brand surface, Brad's personal routine is never an endorsement: give the criteria only, with no brand name or link.");
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

  // R4/R7: the harness compiles patterns with no i flag, so the affirmative
  // wrinkle patterns are case-insensitive by construction, and the negation
  // lookbehind lets negated sentences through.
  describe('collagen wrinkle patterns', () => {
    const wrinkleFixtures = all.filter(q => /collagen/i.test(q.query) && /wrinkle/i.test(q.query) && (q.must_not_match ?? []).some(r => r.startsWith('(?<!')));
    const forbids = (q: Fixture, text: string) => (q.must_not_match ?? []).some(r => new RegExp(r).test(text));
    const AFFIRMATIVE = ['Collagen may reduce wrinkles.', 'Collagen supplements reduce wrinkles.', 'Collagen can reduce the appearance of wrinkles.', 'Collagen reduces fine lines and wrinkles.', 'Collagen improves wrinkles.', 'Collagen reduced wrinkles in trials.', 'Collagen is shown to reduce wrinkles.', 'Collagen helps reduce wrinkles.'];
    const NEGATED = [
      'There is no evidence that collagen reduces wrinkles.', 'There is no evidence collagen reduces wrinkles.',
      "There isn't good evidence that collagen reduces wrinkles.", "There isn't evidence collagen reduces wrinkles.",
      "It's not true that collagen reduces wrinkles.", "The meta-analysis doesn't show collagen reduces wrinkles.",
      'The trials did not show that collagen reduces wrinkles.', "The review didn't find collagen reduces wrinkles.",
      'The review did not find that it reduces wrinkles.', 'Collagen does not reduce wrinkles.', "It doesn't reduce wrinkles.",
    ];
    it('covers the three master fixtures, with no subject-less or "it" pattern (sunscreen and retinoid advice pass)', () => {
      expect(wrinkleFixtures).toHaveLength(3);
      for (const q of wrinkleFixtures) {
        for (const text of ['Sunscreen may help reduce wrinkles.', 'Retinoids can reduce wrinkles.', 'It may help reduce wrinkles.']) expect(forbids(q, text), q.query).toBe(false);
      }
    });
    it.each(AFFIRMATIVE)('every fixture forbids the affirmative "%s", in any case', (text) => {
      for (const q of wrinkleFixtures) {
        expect(forbids(q, text), q.query).toBe(true);
        expect(forbids(q, text.toLowerCase()), q.query).toBe(true);
      }
    });
    it.each(NEGATED)('no fixture forbids the negated "%s"', (text) => {
      for (const q of wrinkleFixtures) {
        expect(forbids(q, text), q.query).toBe(false);
        expect(forbids(q, text.toLowerCase()), q.query).toBe(false);
      }
    });
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

// US-70 AC6: condition guides join the guideline rule and the which-block-wins rule.
describe('answer prompt and condition guides (US-70 AC6)', () => {
  const loaded = section(system, '### On loaded reference content');

  it('"Guideline content" covers condition guides', () => {
    expect(section(system, '### Guideline content')).toContain('When guideline content (diet, exercise, sleep, or a condition guide such as one on blood pressure or cholesterol) is loaded below');
  });

  it("a guide's Brad's view yields to a newer post, and the answer says the view changed", () => {
    expect(loaded).toContain("A condition guide (\"[guideline — reviewed …]\") follows the same rule for its Brad's view section: a loaded post published after the guide's reviewed date wins, and the answer says Brad's view has changed");
    expect(loaded).toContain("a guide's Current evidence position is never Brad's view");
  });

  it('the plan wins over a guide', () => {
    expect(loaded).toContain("If a guide and the user's plan disagree, the plan wins");
  });

  it('reaches the model in the built system prompt', () => {
    const text = buildSystemBlocks('{}').map(b => b.text).join('\n');
    expect(text).toContain("If a guide and the user's plan disagree, the plan wins");
  });
});

// US-15 AC49 (Brad 2026-11-02, "Fix"): a live doctor-surface answer opened with "The user's
// message names MicroVitamin+ directly, so I can answer the factual question." The posture
// and mode rules are applied silently: the reply never narrates them.
describe('rules are applied silently (US-15 AC49)', () => {
  const doctor = readFileSync('app/lib/chat-posture-doctor.md', 'utf-8');
  const SILENT = 'Apply the rules in this prompt silently. Never tell the user which rule, mode or surface applies, or that their message named a product, and never explain that you may answer because of a rule. When a rule tells you to decline, refer, or say what you need or lack, use its words: they are the user-facing reason, not narration.';

  it('the system prompt says so beside the one-mode rule', () => {
    expect(system).toContain(`- ${SILENT}`);
    expect(system.indexOf(SILENT)).toBeLessThan(system.indexOf('- **Each reply is in ONE mode'));
  });

  it('the doctor posture says the naming check is silent', () => {
    expect(doctor).toContain("Make this check silently: never say that the user's message named the product, or that you can answer because it did.");
  });
});

// US-45 AC4 (changed 2026-11-10, Brad: "drstanfield can talk about potassium-fiber drink because it's a drink with no
// health claims"): the doctor posture's second exception, and the YouTube ownership line exempt from the reply caps.
describe('Potassium Fiber Drink on the doctor surfaces (US-45 AC4)', () => {
  const doctor = readFileSync('app/lib/chat-posture-doctor.md', 'utf-8');
  const OWNERSHIP = 'Brad owns the company that sells it and profits from its sale.';
  it('the doctor posture allows it only when the user names it, and never brings it up beside a condition', () => {
    expect(doctor).toContain("when the user's message names it, you may name and describe it from the PRODUCTS section and link https://potassiumfiber.com");
    expect(doctor).toContain('If a question that does not name the drink names a condition or symptom (blood pressure, constipation, kidney disease and the like), or the reply discusses outcome research, do not bring the drink up.');
    expect(doctor).toContain('never steer to it, never recommend it');
  });
  it('a YouTube reply naming the drink carries the exact ownership sentence, outside the sentence and word limits', () => {
    expect(youtube).toContain(`- **Potassium Fiber Drink ownership:** when a reply names or discusses the drink, it must include this exact sentence: "${OWNERSHIP}" This sentence is exempt from the do-not-copy rule above and does not count toward the sentence or word limits.`);
  });
});
