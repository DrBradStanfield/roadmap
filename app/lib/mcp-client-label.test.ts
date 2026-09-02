/**
 * US-32 — which assistant a counter names.
 *
 * The client id is a URL the client chose: for a DCR registration it is
 * attacker-controlled text, and text in a counter is how a counter becomes a
 * log. Only the pinned vendors get a name; everything else is "other".
 */
import { describe, expect, it } from 'vitest';
import { KNOWN_CLIENTS, MCP_CLIENT_LABELS } from './mcp-clients.server';
import { mcpClientLabel } from './mcp.server';

describe('mcpClientLabel', () => {
  it('names each pinned vendor, and nothing else', () => {
    expect([...KNOWN_CLIENTS.keys()].map(mcpClientLabel)).toEqual(['claude', 'claude_code', 'chatgpt']);
  });

  it('reads the label off the table, so renaming a display name cannot move it', () => {
    const renamed = new Map(KNOWN_CLIENTS);
    for (const [id, client] of renamed) renamed.set(id, { ...client, name: 'Something Else' });
    // The label is a field, not a slug of `name`: the two cannot drift.
    expect([...renamed.values()].map((c) => c.label)).toEqual(['claude', 'claude_code', 'chatgpt']);
    for (const client of renamed.values()) expect(MCP_CLIENT_LABELS).toContain(client.label);
  });

  it('calls every other client "other", however it names itself', () => {
    for (const id of ['c.abc.def', 'https://evil.test/client.json', '', 'Claude']) {
      expect(mcpClientLabel(id), id).toBe('other');
    }
  });
});
