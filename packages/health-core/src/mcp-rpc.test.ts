/**
 * US-32 — the one JSON-RPC dispatch both MCP servers run.
 *
 * What is pinned here is the switch itself: the capabilities a client is told
 * about, the four prompts a person can pick without knowing what to type, and
 * the two ways a tool call can end. Each server's own half — its guards, its
 * storage, its wording — is pinned in its own suite.
 */
import { describe, expect, it } from 'vitest';
import { dispatchRpc, INTERNAL_ERROR, INVALID_PARAMS, METHOD_NOT_FOUND, type RpcSurface } from './mcp-rpc';
import { MCP_PROMPTS, MCP_TOOLS } from './mcp-tools';

const surface: RpcSurface = {
  protocolVersion: (asked) => (asked === '2025-06-18' ? asked : '2025-11-25'),
  serverInfo: { name: 'health-roadmap', title: 'Health by Dr Brad', version: '1.0.2' },
  instructions: 'Read before you write.',
  callTool: async (name) =>
    name === 'boom' ? { errorMessage: 'That tool failed inside this server.' } : { answer: { text: 'done', isError: false } },
};

const PUBLISHED = ['name', '_meta', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'];

function send(method: string, params: object = {}) {
  return dispatchRpc({ jsonrpc: '2.0', id: 1, method, params }, surface) as
    Promise<{ result?: Record<string, never> & Record<string, unknown>; error?: { code: number } } | null>;
}

describe('US-32 — the shared dispatch', () => {
  it('advertises both tools and prompts, and negotiates the revision', async () => {
    const answer = await send('initialize', { protocolVersion: '2025-06-18' });
    expect(answer!.result!.capabilities).toEqual({ tools: { listChanged: false }, prompts: { listChanged: false } });
    expect(answer!.result!.protocolVersion).toBe('2025-06-18');
    expect((await send('initialize', { protocolVersion: '1999-01-01' }))!.result!.protocolVersion).toBe('2025-11-25');
  });

  it('lists the tools with the two words ChatGPT shows, and none of the server\'s own fields (US-32 AC51)', async () => {
    const listed = (await send('tools/list'))!.result!.tools as Array<Partial<(typeof MCP_TOOLS)[number]>>;
    expect(listed).toHaveLength(MCP_TOOLS.length);
    for (const tool of listed) {
      // `cost` is the hosted server's own budget weight and `run` its dispatch
      // mode; neither is a tool fact (US-35 live verify 2026-09-05 saw `run` leak).
      expect(Object.keys(tool), tool.name).not.toContain('cost');
      expect(Object.keys(tool), tool.name).not.toContain('run');
      // US-32 AC51 (2026-10-21): `nudge`, `twoPhase` and `imports` leaked too
      // (found while adding AC50). Only the spec's Tool fields are published.
      expect(Object.keys(tool).sort(), tool.name).toEqual([...PUBLISHED].sort());
      expect(tool._meta!['openai/toolInvocation/invoking'].length, tool.name).toBeLessThanOrEqual(64);
      expect(tool._meta!['openai/toolInvocation/invoked'].length, tool.name).toBeLessThanOrEqual(64);
    }
  });

  // US-32 AC50 (2026-10-21): Anthropic's directory form flagged all nine tools
  // "Missing title annotation" — it reads ToolAnnotations.title, not Tool.title.
  it('puts every tool\'s display title in its annotations too, hints untouched (US-32 AC50)', async () => {
    // A surface's own list (the hosted knowledge tools, US-41) is titled the same way.
    const extra = { ...MCP_TOOLS[0], name: 'extra_tool', title: 'An extra tool' };
    for (const tools of [undefined, [...MCP_TOOLS, extra]]) {
      const answer = (await dispatchRpc({ jsonrpc: '2.0', id: 1, method: 'tools/list' }, { ...surface, tools })) as
        { result: { tools: Array<{ name: string; title: string; annotations: Record<string, unknown> }> } };
      const source = tools ?? MCP_TOOLS;
      expect(answer.result.tools).toHaveLength(source.length);
      answer.result.tools.forEach((tool, i) => {
        expect(tool.title.length, tool.name).toBeGreaterThan(0);
        expect(tool.annotations, tool.name).toEqual({ ...source[i].annotations, title: tool.title });
        expect(tool.title, tool.name).toBe(source[i].title);
      });
    }
    // The definitions themselves stay as they were: the title is added on the wire only.
    expect(MCP_TOOLS.every((t) => !('title' in t.annotations))).toBe(true);
  });

  // The list names fields one by one, so a NEW definition field (MCP `icons`,
  // say) would be dropped silently: every definition key is published or is
  // one of the server's own (US-32 AC51).
  it('publishes every definition field that is not the server\'s own (US-32 AC51)', () => {
    const serverOnly = ['cost', 'run', 'imports', 'twoPhase', 'canonicalArgs', 'nudge'];
    for (const tool of MCP_TOOLS) {
      for (const key of Object.keys(tool)) expect([...PUBLISHED, ...serverOnly], `${tool.name}.${key}`).toContain(key);
    }
  });

  it('offers the four prompts by name, and hands back the words behind one', async () => {
    const listed = (await send('prompts/list'))!.result!.prompts as Array<{ name: string; title: string; text?: string }>;
    expect(listed.map((p) => p.name)).toEqual(['summarise_my_plan', 'add_todays_results', 'whats_missing', 'import_my_lab_files']);
    // The list is a menu, not the message: the text arrives on prompts/get.
    expect(listed.every((p) => p.text === undefined)).toBe(true);

    const got = (await send('prompts/get', { name: 'whats_missing' }))!.result!;
    expect(got.messages).toEqual([{ role: 'user', content: { type: 'text', text: MCP_PROMPTS[2].text } }]);

    expect((await send('prompts/get', { name: 'nope' }))!.error!.code).toBe(INVALID_PARAMS);
  });

  it('carries a tool answer through, and a server-side failure as -32603 on the same id', async () => {
    expect((await send('tools/call', { name: 'read_record' }))!.result!.content).toEqual([{ type: 'text', text: 'done' }]);
    const failed = (await dispatchRpc({ jsonrpc: '2.0', id: 77, method: 'tools/call', params: { name: 'boom' } }, surface)) as
      { id: number; error: { code: number } };
    expect(failed.id).toBe(77);
    expect(failed.error.code).toBe(INTERNAL_ERROR);
  });

  it('answers a request it does not know, and stays silent on a notification', async () => {
    expect((await send('server/discover'))!.error!.code).toBe(METHOD_NOT_FOUND);
    expect(await dispatchRpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, surface)).toBeNull();
  });
});
