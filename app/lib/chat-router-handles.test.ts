import { describe, it, expect, vi } from 'vitest';
import { routeQuery, sanitizeRawHandles, VALID_HANDLES } from './chat-router.server';
import { callAnthropicWithUsage } from './anthropic.server';

vi.mock('./anthropic.server', async (orig) => ({
  ...(await orig<typeof import('./anthropic.server')>()),
  callAnthropicWithUsage: vi.fn(),
}));

// US-15 AC28a: the router keeps up to three handles it knows. A handle it
// made up, a repeat or an overlong string is dropped before the cut to three,
// so it neither takes a known handle's place nor voids the reply. Handles are
// read from the live allow-list so the test tracks the index.

const reply = (handles: unknown[]) => vi.mocked(callAnthropicWithUsage).mockResolvedValueOnce({
  content: JSON.stringify({ handles }),
  usage: { inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 },
} as Awaited<ReturnType<typeof callAnthropicWithUsage>>);

const [a, b, c, d] = [...VALID_HANDLES];

describe('routeQuery: US-15 AC28a only known handles fill the three places', () => {
  it('has four known handles to test with', () => {
    expect([a, b, c, d].every(Boolean)).toBe(true);
  });

  it('a made-up first handle does not push out a known one', async () => {
    reply(['not-a-real-handle', a, b, c]);
    const r = await routeQuery('q');
    expect(r).toMatchObject({ handles: [a, b, c], error: null });
  });

  it('a repeated handle takes one place', async () => {
    reply([a, a, b, c]);
    expect((await routeQuery('q')).handles).toEqual([a, b, c]);
  });

  it('a repaired handle and its plain form take one place', async () => {
    reply([`guideline-${a}`, b, a]);
    expect((await routeQuery('q')).handles).toEqual([a, b]);
  });

  it('an overlong string is dropped and the reply still routes', async () => {
    reply(['x'.repeat(121), a, b]);
    const r = await routeQuery('q');
    expect(r).toMatchObject({ handles: [a, b], error: null });
  });

  it('keeps the first three known handles in the order sent', async () => {
    reply([d, c, b, a]);
    expect((await routeQuery('q')).handles).toEqual([d, c, b]);
  });

  it('without an allow-list, keeps every non-empty entry, one character included, and drops repeats', () => {
    expect(sanitizeRawHandles(['x', '', 'x', ' Y '])).toEqual(['x', 'y']);
  });

  it('a reply with no known handle routes nowhere, with no error', async () => {
    reply(['made-up-one', 'made-up-two']);
    expect(await routeQuery('q')).toMatchObject({ handles: [], error: null });
  });
});
