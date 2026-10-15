/**
 * US-15 AC33: when the model calls run_roadmap, getChatCompletion runs the plan
 * code on the request's guestInputs plus the stated values, and a second call
 * answers from its output. At most one round; the first reply is replayed
 * unmodified; a failed second call is the ordinary api-error fallback.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@sentry/react-router', () => ({ captureException: vi.fn(), captureMessage: vi.fn() }));
vi.mock('./cron-helpers.server', () => ({ sleep: vi.fn().mockResolvedValue(undefined) }));

process.env.ANTHROPIC_API_KEY = 'sk-test-dummy';

import { getChatCompletion, FALLBACK_RESPONSE, ROADMAP_STATUS } from './chat.server';
import { runRoadmap } from '../../packages/health-core/src/run-roadmap';

const REAL_FETCH = global.fetch;
afterEach(() => { global.fetch = REAL_FETCH; vi.clearAllMocks(); });

const PROFILE = {
  unitSystem: 'si', medications: [], screenings: [],
  sex: 'female', heightCm: 165, weightKg: 62, waistCm: 78, birthYear: 1975, birthMonth: 4, ldlC: 2.2,
};
const STATED = { values: [{ field: 'ldlC', value: 4.1, unit: 'mmol/L' }, { field: 'hba1c', value: 41, unit: 'mmol/mol' }] };
const THINKING = { type: 'thinking', thinking: 'They gave values; run the roadmap.', signature: 'EqQBCkgIARABGAIiQ...sig' };
const RUN = { type: 'tool_use', id: 'toolu_run', name: 'run_roadmap', input: STATED };
const FIELD = { type: 'tool_use', id: 'toolu_field', name: 'propose_field_edit', input: { field: 'ldlC', value: 4.1, unit: 'mmol/L' } };
const ANSWER = 'Your roadmap, with LDL 4.1, says this.';

const json = (stop_reason: string, content: unknown[], usage = { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 }) =>
  ({ ok: true, status: 200, json: async () => ({ content, stop_reason, stop_details: null, usage }) }) as unknown as Response;

function replies(...responses: Array<Response | Error>) {
  const fetchMock = vi.fn();
  for (const r of responses) {
    if (r instanceof Error) fetchMock.mockRejectedValueOnce(r);
    else fetchMock.mockResolvedValueOnce(r);
  }
  global.fetch = fetchMock as unknown as typeof fetch;
  return { fetchMock, bodies: () => fetchMock.mock.calls.map((c) => JSON.parse(c[1].body)) };
}

const user = [{ role: 'user' as const, content: 'analyse my data: LDL 4.1 mmol/L, HbA1c 41 mmol/mol' }];

describe('US-15 AC33: the run_roadmap round (JSON path)', () => {
  it('two calls: the second replays the first reply, answers each tool_use, offers no tools, and is the answer', async () => {
    const { bodies } = replies(
      json('tool_use', [THINKING, { type: 'text', text: 'Let me run that.' }, RUN, FIELD]),
      json('end_turn', [{ type: 'text', text: ANSWER }]),
    );
    const result = await getChatCompletion([], user, true, undefined, PROFILE);
    const [first, second] = bodies();
    expect(bodies()).toHaveLength(2);
    expect(first).not.toHaveProperty('tool_choice');
    expect(second.tool_choice).toEqual({ type: 'none' });
    expect(second.tools).toEqual(first.tools);
    expect(second.system).toEqual(first.system);
    expect(second.messages[0]).toEqual(user[0]);
    expect(second.messages[1]).toEqual({ role: 'assistant', content: [THINKING, { type: 'text', text: 'Let me run that.' }, RUN, FIELD] });
    const [runResult, fieldResult] = second.messages[2].content;
    expect(runResult).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_run' });
    expect(JSON.parse(runResult.content).roadmap).toEqual(JSON.parse(runRoadmap(PROFILE, STATED).contextJson!));
    expect(JSON.parse(runResult.content).roadmap.latestValues.ldlC).toBe('4.1');
    expect(fieldResult).toEqual({ type: 'tool_result', tool_use_id: 'toolu_field', content: 'Pre-filled for the user to review and Save.' });

    expect(result).toMatchObject({ content: ANSWER, isFallback: false, stopReason: 'end_turn', roadmapRun: { applied: 2, rejected: 0 } });
    expect(result.proposedEdits).toEqual([{ kind: 'field', field: 'ldlC', displayValue: 4.1, unitSystem: 'si', date: null }]);
    expect(result.usage).toEqual({ inputTokens: 20, outputTokens: 10, cacheCreationTokens: 0, cacheReadTokens: 200 });
  });

  it('one round at most: a second reply that asks again gets no third call', async () => {
    const { bodies } = replies(json('tool_use', [RUN]), json('tool_use', [{ type: 'text', text: ANSWER }, RUN]));
    const result = await getChatCompletion([], user, true, undefined, PROFILE);
    expect(bodies()).toHaveLength(2);
    expect(result.content).toBe(ANSWER);
  });

  it('a failed second call is the api-error fallback, with no tool output and no edits', async () => {
    replies(json('tool_use', [RUN, FIELD]), new TypeError('fetch failed'), new TypeError('fetch failed'));
    const result = await getChatCompletion([], user, true, undefined, PROFILE);
    expect(result).toMatchObject({ content: FALLBACK_RESPONSE, isFallback: true, failureMode: 'api-error', errorKind: 'timeout' });
    expect(result).not.toHaveProperty('proposedEdits');
    expect(JSON.stringify(result)).not.toContain('4.1');
  });

  it('US-15 AC33 (S4): a failed second call keeps the first call\'s usage and still records the round', async () => {
    replies(json('tool_use', [RUN, FIELD]), new TypeError('fetch failed'), new TypeError('fetch failed'));
    const result = await getChatCompletion([], user, true, undefined, PROFILE);
    expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5, cacheCreationTokens: 0, cacheReadTokens: 100 });
    expect(result.roadmapRun).toEqual({ applied: 2, rejected: 0 });
  });

  it('a failed first call reports zero usage and no round, as before', async () => {
    replies(new TypeError('fetch failed'), new TypeError('fetch failed'));
    const result = await getChatCompletion([], user, true, undefined, PROFILE);
    expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0 });
    expect(result).not.toHaveProperty('roadmapRun');
  });

  it('no run_roadmap: one call, as before', async () => {
    const { bodies } = replies(json('end_turn', [{ type: 'text', text: 'An answer.' }]));
    const result = await getChatCompletion([], user, true, undefined, PROFILE);
    expect(bodies()).toHaveLength(1);
    expect(result).not.toHaveProperty('roadmapRun');
  });

  it('no tools (Discord, YouTube, the bubble, the embed): a run_roadmap block is never run', async () => {
    const { bodies } = replies(json('tool_use', [{ type: 'text', text: 'An answer.' }, RUN]));
    const result = await getChatCompletion([], user, false, undefined, PROFILE);
    expect(bodies()).toHaveLength(1);
    expect(bodies()[0]).not.toHaveProperty('tools');
    expect(result).not.toHaveProperty('roadmapRun');
  });
});

describe('US-15 AC33: the run_roadmap round (streamed)', () => {
  const sse = (events: unknown[]) => new Response(
    events.map((e) => `event: ${(e as { type: string }).type}\ndata: ${JSON.stringify(e)}\n\n`).join(''),
    { status: 200, headers: { 'content-type': 'text/event-stream' } });
  const start = { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 1 } } };
  const end = (stop_reason: string) => [{ type: 'message_delta', delta: { stop_reason }, usage: { output_tokens: 5 } }, { type: 'message_stop' }];

  it('streams the first text, a status line, then the answer; the signed thinking block is replayed whole', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(sse([start,
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Run it.' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-1' } },
        { type: 'content_block_stop', index: 0 },
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_run', name: 'run_roadmap', input: {} } },
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: JSON.stringify(STATED) } },
        { type: 'content_block_stop', index: 1 },
        ...end('tool_use')]))
      .mockResolvedValueOnce(sse([start,
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ANSWER } },
        { type: 'content_block_stop', index: 0 },
        ...end('end_turn')]));
    global.fetch = fetchMock as unknown as typeof fetch;
    const onEvent = vi.fn();
    const result = await getChatCompletion([], user, true, onEvent, PROFILE);

    expect(onEvent.mock.calls.map((c) => c[0])).toEqual([
      { type: 'thinking', text: 'Run it.' },
      { type: 'status', text: ROADMAP_STATUS },
      { type: 'text', text: ANSWER },
    ]);
    const second = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(second.stream).toBe(true);
    expect(second.messages[1].content).toEqual([
      { type: 'thinking', thinking: 'Run it.', signature: 'sig-1' },
      { type: 'tool_use', id: 'toolu_run', name: 'run_roadmap', input: STATED },
    ]);
    expect(result).toMatchObject({ content: ANSWER, isFallback: false, roadmapRun: { applied: 2, rejected: 0 } });
  });
});
