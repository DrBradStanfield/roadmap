/**
 * US-15 AC79 (Brad 2026-11-27): the YouTube bot replies as Brad, in the first person, names no Dr Brad
 * supplement and says nothing of what he takes, and may link https://potassiumfiber.com when a reply names
 * the drink. No AI disclosure. The web chat (both stores) and Discord keep their voice and link rules.
 * runPipeline is real; the classifier, router and answer call are stubbed, and the post's fetch is faked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { readFileSync } from 'fs';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./supabase-client.server', () => ({ supabaseAdmin: null }));
vi.mock('./chat-classifier.server', async (orig) => ({
  ...(await orig<typeof import('./chat-classifier.server')>()),
  classifyMessage: vi.fn(async () => ({ classification: 'ROUTE' })),
}));
vi.mock('./chat-router.server', async (orig) => ({
  ...(await orig<typeof import('./chat-router.server')>()),
  routeQuery: vi.fn(async () => ({ handles: [], rawJson: '{"handles":[]}', usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, latencyMs: 1, cacheHit: false, error: null })),
}));
const DRINK_REPLY = 'Each scoop has 8 g of fiber and 500 mg of potassium (https://potassiumfiber.com). I own the company that sells it and profit from its sale.';
vi.mock('./chat.server', async (orig) => ({
  ...(await orig<typeof import('./chat.server')>()),
  getChatCompletion: vi.fn(async () => ({ content: DRINK_REPLY, usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 }, isFallback: false })),
}));

import { runPipeline } from './youtube-bot.server';
import { addressReply, postReply } from './youtube-bot-api.server';
import { getChatCompletion, buildSystemBlocks, DOCTOR_POSTURE, BRAND_POSTURE } from './chat.server';
import { SAVED_CHAT_BY_RETENTION, savedChatBlock } from './chat-save-answers';

const youtube = readFileSync('app/lib/chat-youtube-prompt.md', 'utf-8');
const system = readFileSync('app/lib/chat-system-prompt.md', 'utf-8');
const doctor = readFileSync('app/lib/chat-posture-doctor.md', 'utf-8');
const brand = readFileSync('app/lib/chat-posture-brand.md', 'utf-8');
const discordSrc = readFileSync('app/lib/platform-chat.server.ts', 'utf-8');

const thread = { topLevelCommentId: 'c1', videoId: 'vid1', authorDisplayName: 'V', authorChannelId: null, text: 'What is in the Potassium Fiber drink?', publishedAt: '2026-11-27T00:00:00Z' };
const entry = { title: 'A video', handle: 'a-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z' };

afterEach(() => vi.unstubAllGlobals());

describe('US-15 AC79: the YouTube bot speaks as Brad, in the first person', () => {
  it('the YouTube prompt opens as Brad and carries the two rules, above every other rule but Step 0', () => {
    expect(youtube.split('\n')[0]).toBe('Platform: YouTube — you are Dr Brad Stanfield, replying in the first person to a public comment on your own video.');
    expect(youtube).not.toContain("Dr Brad's AI assistant");
    expect(youtube).toContain('## Who you are on YouTube (these rules override the SURFACE CONTEXT and every other rule, except Step 0)');
    expect(youtube).toContain('- "I" states only what your videos and articles say. Never invent experiences, patients, opinions or habits. The clinical-practice voice ("what I tell my patients") is fine.');
    expect(youtube).toContain('- Never name a Dr Brad supplement (MicroVitamin, MicroVitamin+, Sleep), even if the comment names it, and never say or imply which supplements you take. Discuss supplement research in neutral terms.');
    // No third-person Brad left in the reply guidance, beyond the master-views heading the code adds.
    const prose = youtube.replaceAll("## Brad's current view and safety notes", '').replace('Speak as Brad', '').replace('calls you Brad', '');
    expect(prose).not.toMatch(/\bBrad's\b|\bBrad (has|earns|owns)\b/);
    // No AI disclosure (Brad 2026-11-27, option a; AC43 already removed the tag).
    expect(youtube).not.toMatch(/\bAI\b/);
  });

  it('the shared prompt lets the YouTube identity and product rules outrank the SURFACE CONTEXT, on YouTube only', () => {
    expect(system).toContain("On YouTube only, the YouTube platform prompt's identity and product rules outrank the SURFACE CONTEXT.");
    expect(system).toContain(`its first-person clinical voice ("I tell my patients") is Brad's own, never yours, except on YouTube, where you reply as Brad (its platform prompt);`);
    expect(system).toContain("On YouTube, its platform prompt's voice and product rules apply instead.");
    expect(doctor).toContain("- Refer to yourself as Dr Brad's AI assistant (on YouTube, its platform prompt's identity applies instead).");
  });

  it('the assembled YouTube prompt carries the first-person identity and the no-supplement rule', async () => {
    await runPipeline(thread, entry, 'The video body.');
    const prompt = (vi.mocked(getChatCompletion).mock.calls.at(-1)![0] as Array<{ text: string }>).map(b => b.text).join('\n\n');
    expect(prompt).toContain('Platform: YouTube — you are Dr Brad Stanfield, replying in the first person');
    expect(prompt).toContain('never say or imply which supplements you take');
    expect(prompt).toContain('Such a reply may link https://potassiumfiber.com');
    expect(prompt).toContain('Make no health claims about the drink: nutrient content only.');
  });

  it('a potassiumfiber.com link survives to the posted reply', async () => {
    const outcome = await runPipeline(thread, entry, 'The video body.');
    expect(outcome).toMatchObject({ posted: true, replyText: DRINK_REPLY });
    const fetchMock = vi.fn(async () => new Response('{"id":"r1"}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    await postReply('test-token-good', thread.topLevelCommentId, addressReply(outcome.replyText!, '@viewer'));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body.snippet.textOriginal).toBe(`@viewer ${DRINK_REPLY}`);
    expect(body.snippet.textOriginal).toContain('https://potassiumfiber.com');
  });
});

describe('US-15 AC79: the web chat and Discord keep their voice and link rules', () => {
  it('the brand posture still says it is not Dr Brad and links the drink only on microvitamin.com', () => {
    expect(brand).toContain('- You are **NOT Dr Brad.** Never refer to yourself as Dr Brad or "Dr Brad\'s assistant"');
    const brandPrompt = buildSystemBlocks('{}', { surfaceContext: BRAND_POSTURE, savedChat: savedChatBlock(SAVED_CHAT_BY_RETENTION.transcript) }).map(b => b.text).join('\n\n');
    expect(brandPrompt).not.toContain('Platform: YouTube');
    expect(brandPrompt).toContain('You are **NOT Dr Brad.**');
  });

  it('the doctor posture (drstanfield.com, Discord) keeps the assistant identity, its product rule and its drink link rule', () => {
    expect(doctor).toContain("You are Dr Brad's evidence-based education assistant.");
    expect(doctor).toContain("- **Name a Dr Brad product ONLY when the user's own message names it**");
    expect(doctor).toContain("when the user's message names it, you may name and describe it from the PRODUCTS section and link https://potassiumfiber.com. Never name or link microvitamin.com for it.");
    expect(doctor).toContain('Every time you discuss it, say that Brad owns the company that sells it and profits from its sale.');
    expect(discordSrc).toContain("Platform: Discord — you are Dr Brad's AI assistant");
    const doctorPrompt = buildSystemBlocks('{}', { surfaceContext: DOCTOR_POSTURE, savedChat: savedChatBlock(SAVED_CHAT_BY_RETENTION.transcript) }).map(b => b.text).join('\n\n');
    expect(doctorPrompt).not.toContain('Platform: YouTube');
  });
});
