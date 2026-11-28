/**
 * US-15 AC34: the Pages build's shared transport to Anthropic, on the person's own key. A reply that
 * holds only a tool call (a proposed form edit) comes back as the answer, never as the error
 * "Empty response from Anthropic. Try again.", which AC34 keeps for a reply with nothing to show.
 * fetch stands in for Anthropic; synthetic replies only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { callAnthropicDirectRaw } from './byok-anthropic';

afterEach(() => { vi.unstubAllGlobals(); });

describe('US-15 AC34: a reply that only proposes a form edit is not empty', () => {
  it('only a tool_use block: returned as the answer, no error', async () => {
    const edit = { type: 'tool_use', id: 'toolu_synthetic', name: 'propose_field_edit', input: { field: 'weightKg', value: 70, unit: 'kg' } };
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ stop_reason: 'tool_use', content: [edit] })));
    const reply = await callAnthropicDirectRaw('test-key-synthetic', {});
    expect(reply.text).toBe('');
    expect(reply.blocks).toEqual([expect.objectContaining({ type: 'tool_use', name: 'propose_field_edit' })]);
  });
});
