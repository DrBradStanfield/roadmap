/**
 * US-50 AC3: the router's index block, its handle allow-list and its stated
 * entry count all come from the router view, so a hidden post is gone from all
 * three. loadBlogIndex() itself is untouched (YouTube finds posts by video ID).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';

const fixture = vi.hoisted(() => [
  { title: 'Collagen', handle: 'collagen', url: 'u', tags: [], publishedAt: '2024-01-01T00:00:00Z', type: 'reference', reviewed: '2026-10-20' },
  { title: 'Old collagen video', handle: 'collagen-video', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z', youtube: 'https://youtu.be/abc', topics: ['collagen'], router: 'hidden' },
  { title: 'Mixed skin post', handle: 'skin-aging', url: 'u', tags: [], publishedAt: '2025-03-12T00:00:00Z', topics: ['collagen'] },
]);

vi.mock('./blog-index.server', async (orig) => ({
  isMaster: (await orig<typeof import('./blog-index.server')>()).isMaster,
  loadBlogIndex: () => fixture,
}));
vi.mock('./anthropic.server', async (orig) => ({
  ...(await orig<typeof import('./anthropic.server')>()),
  callAnthropicWithUsage: vi.fn(async () => ({
    content: '{"handles":["collagen-video","collagen"]}',
    usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
  })),
}));

import { routeQuery, VALID_HANDLES, ROUTER_VERSION } from './chat-router.server';
import { callAnthropicWithUsage } from './anthropic.server';

describe('router view in the router call (US-50 AC3)', () => {
  it('the allow-list holds the view only', () => {
    expect([...VALID_HANDLES].sort()).toEqual(['collagen', 'skin-aging']);
  });

  it('the index block and entry count match the view, and a hidden handle is dropped from the reply', async () => {
    const r = await routeQuery('does collagen help skin');
    const body = vi.mocked(callAnthropicWithUsage).mock.calls[0][0] as { system: Array<{ text: string }> };
    const [prompt, index] = body.system.map(b => b.text);
    expect(prompt).toContain('a 2-entry index');
    expect(index.split('\n')).toHaveLength(2);
    expect(index).not.toContain('collagen-video');
    expect(r.handles).toEqual(['collagen']);
  });

  it('ROUTER_VERSION is bumped for the view change', () => {
    expect(ROUTER_VERSION).toBeGreaterThanOrEqual(3);
  });
});

// US-70 AC5: rule 1 lets a condition guide take a condition, and a symptom only when the guide covers it directly.
describe('router rule 1 and condition guides (US-70 AC5)', () => {
  const prompt = readFileSync('app/lib/chat-router-prompt.md', 'utf-8');
  const rule1 = prompt.slice(prompt.indexOf('1. For SYMPTOM descriptions'), prompt.indexOf('2. Population context'));

  it('no longer says the index has no diagnosis entries', () => {
    expect(rule1).not.toContain('the index has no symptom or diagnosis entries');
  });

  it('routes a named condition, or a reading for it, to its condition guide', () => {
    expect(rule1).toContain("a condition the user names, or a reading or result the user reports for it");
    expect(rule1).toContain("→ that condition's [guideline] (a condition guide");
  });

  it('keeps "do not anchor on one diagnosis", now naming guides too, and says when a guide covers a symptom', () => {
    expect(rule1).toContain('Do NOT route a symptom to an article or condition guide about one specific diagnosis the user did not name');
    expect(rule1).toContain('Anchoring the main LLM on one possibility misses the differential');
    expect(rule1).toContain('A condition guide covers a symptom directly only when the user reports a reading');
    expect(rule1).toContain('Otherwise return an empty list.');
  });

  // Review A1: a named condition with no guide routes exactly as in v4, never into rule 1's empty fallback.
  it('a named condition with no guide routes by rule 6 and the NAMED-topic rule, outside rule 1\'s empty fallback', () => {
    expect(rule1).toContain('A named condition with no condition guide routes by rule 6 and the NAMED-topic rule exactly as before');
    expect(rule1).toContain("rule 1's empty fallback applies to symptoms only, never to a named condition");
    // The empty fallback closes the symptom paragraph, before any condition-guide routing.
    expect(rule1.indexOf('Otherwise return an empty list.')).toBeLessThan(rule1.indexOf("that condition's [guideline]"));
  });

  // Review A2: a red-flag symptom never routes to a guide because the user also names a condition.
  it('a red-flag symptom never routes to a guide on account of a condition; only a reading at the guide\'s red-flag level ties them', () => {
    expect(rule1).toContain('A red-flag symptom never routes to a condition guide on account of a condition the user mentions');
    for (const sign of ['chest pain', 'face drooping, arm weakness or slurred speech', 'anaphylaxis', 'sepsis', 'suicide or self-harm']) expect(rule1).toContain(sign);
    expect(rule1).toContain('("chest pain, and I have high cholesterol" → empty)');
    expect(rule1).toContain("only when the user reports a reading at the guide's own red-flag level");
    expect(rule1).not.toContain('ties the symptom to that condition');
  });

  it('is ROUTER_VERSION 5', () => {
    expect(ROUTER_VERSION).toBe(5);
  });
});
