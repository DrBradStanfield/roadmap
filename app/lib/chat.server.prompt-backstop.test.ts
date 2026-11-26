/**
 * US-15 AC65 backstop: getChatCompletion throws and makes no model call when a
 * chat doc is missing, whatever its caller checked. US-15 AC74: the error names
 * the missing files (names only), not always the prompt.
 */
import { describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  callAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
  streamAnthropic: vi.fn(async () => { throw new Error('no model call in this test'); }),
}));
// The real chat docs, with two required files absent on disk.
vi.mock('fs', async (original) => {
  const real = await original<typeof import('fs')>();
  const readFileSync = ((file: string, ...rest: unknown[]) => {
    if (['health_roadmap_algorithm.md', 'app/lib/chat-posture-brand.md'].some((f) => String(file).endsWith(f))) throw new Error('ENOENT');
    return (real.readFileSync as (...a: unknown[]) => unknown)(file, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});
vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./anthropic.server', async (original) => ({
  ...await original<typeof import('./anthropic.server')>(),
  callAnthropicWithUsage: spies.callAnthropic,
  streamAnthropicWithUsage: spies.streamAnthropic,
}));

import { buildSystemBlocks, getChatCompletion, surfacePosture } from './chat.server';
import { routeQuery } from './chat-router.server';

describe('US-15 AC65: getChatCompletion backstop', () => {
  it.each([['plain', undefined], ['streamed', () => {}]])('%s: US-15 AC74 throws naming the missing docs, no model call', async (_case, onEvent) => {
    const error = new Error('Chat docs missing (health_roadmap_algorithm.md, app/lib/chat-posture-brand.md); no model call');
    // US-15 AC79: the prompt builders throw the same words: no blocks or posture without the docs.
    expect(() => buildSystemBlocks('{}', { savedChat: '' })).toThrow(error);
    expect(() => surfacePosture('brand')).toThrow(error);
    const blocks = [{ type: 'text' as const, text: 'blocks built elsewhere' }];
    await expect(getChatCompletion(blocks, [{ role: 'user', content: 'hello' }], false, onEvent, { purpose: 'CHAT' }))
      .rejects.toThrow(error);
    expect(spies.callAnthropic).not.toHaveBeenCalled();
    expect(spies.streamAnthropic).not.toHaveBeenCalled();
  });
});

describe('US-15 AC79: the router backstop', () => {
  it('routeQuery returns the missing docs as its error, with no router call', async () => {
    const r = await routeQuery('hello', undefined, undefined, 'CHAT');
    expect(r).toMatchObject({ handles: [], rawJson: null, error: 'Chat docs missing (health_roadmap_algorithm.md, app/lib/chat-posture-brand.md); no model call' });
    expect(spies.callAnthropic).not.toHaveBeenCalled();
  });
});
