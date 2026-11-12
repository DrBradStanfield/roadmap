/**
 * US-15 AC65: /healthz fails only when the chat system prompt is missing, so a
 * canary of an image without it never takes traffic. It stays cheap: no
 * network and no database, so nothing else can fail it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  prompt: { kind: 'loaded', text: 'synthetic prompt' } as { kind: 'loaded'; text: string } | { kind: 'missing' },
}));
vi.mock('../lib/chat-system-prompt.server', () => ({ get CHAT_PROMPT() { return state.prompt; } }));

import { loader } from './healthz';

afterEach(() => {
  state.prompt = { kind: 'loaded', text: 'synthetic prompt' };
  vi.unstubAllGlobals();
});

describe('US-15 AC65: /healthz', () => {
  it('missing prompt: 503', async () => {
    state.prompt = { kind: 'missing' };
    const res = await loader();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'chat-prompt-missing' });
  });

  it('loaded prompt: 200 with no other dependency called', async () => {
    const fetchSpy = vi.fn(() => { throw new Error('no network in healthz'); });
    vi.stubGlobal('fetch', fetchSpy);
    const res = await loader();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ok' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('imports nothing that can fail for another reason', async () => {
    const fs = await import('fs');
    const source = fs.readFileSync(new URL('./healthz.ts', import.meta.url), 'utf-8');
    const imports = [...source.matchAll(/^import .* from ['"](.+)['"];?$/gm)].map((m) => m[1]);
    expect(imports).toEqual(['../lib/chat-system-prompt.server']);
  });
});
