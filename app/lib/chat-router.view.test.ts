/**
 * US-50 AC3: the router's index block, its handle allow-list and its stated
 * entry count all come from the router view, so a hidden post is gone from all
 * three. loadBlogIndex() itself is untouched (YouTube finds posts by video ID).
 */
import { describe, it, expect, vi } from 'vitest';

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
