// The router harness's paid calls (tools/test-chatbot-matching.ts): the router and answer calls (scored by
// harness-answers.ts scoreAnswer), and the run loop. apiErrorCount lives here with every call that counts an error.
import { CHAT_EFFORT, CHAT_MAX_TOKENS, PROMPT_CACHE, modelParams, toStat } from '../packages/health-core/src/models';
import { chatToolsFor, withRoadmapRound, type ChatContentBlock } from '../packages/health-core/src/run-roadmap';
import { loadMatchedContent } from '../app/lib/matched-content';
import { preferMasters } from '../app/lib/router-view';
import { youtubeTurn } from './chatbot-surfaces';
import { scoreAnswer } from './harness-answers';
import { parseRouterReply } from '../app/lib/router-reply';
import { EMPTY_CHAT_CONTEXT, buildSystemBlocks } from '../app/lib/chat.server';
import {
  ANSWER_MODEL, FULL_INDEX, POSTURES, ROUTER_INDEX_BLOCK, ROUTER_MODEL, ROUTER_PROMPT, SAVED_CHATS,
  USER_CONTEXTS, VALID_HANDLES, YOUTUBE_VIDEOS, answerCheckRuns, answerStats, apiKey, callStats, concurrency, hasAnswerCheck,
  repairHandle, runs, suite, thinkingOff, type TestQuery,
} from './test-chatbot-matching-setup';
export let apiErrorCount = 0;

// ---------------------------------------------------------------------------
// Anthropic API call — minimal fetch glue, same body shape as routeQuery
// ---------------------------------------------------------------------------

interface RouteResult {
  handles: string[];
  rateLimited: boolean;
}

// A timeout, DNS failure or reset throws instead of returning a status. Return
// it as a label so each caller scores it like a non-2xx: one slow call must not
// kill a 304-case run (2026-09-29).
async function postMessages(body: object, timeoutMs: number): Promise<Response | string> {
  try {
    return await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey!,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && err.name === 'TimeoutError') return 'timeout';
    return String((err as { cause?: { code?: string } }).cause?.code ?? err).slice(0, 100);
  }
}

export async function routeQuery(currentMessage: string, retryOnRateLimit = true, record = true): Promise<RouteResult> {
  const t0 = Date.now();
  const body = {
    ...modelParams(ROUTER_MODEL, 200, thinkingOff ? 'off' : 'low'),
    system: [
      { type: 'text', text: ROUTER_PROMPT, cache_control: PROMPT_CACHE },
      { type: 'text', text: ROUTER_INDEX_BLOCK, cache_control: PROMPT_CACHE },
    ],
    messages: [{ role: 'user', content: `Current query: ${currentMessage}` }],
  };

  const res = await postMessages(body, 30_000);
  if (typeof res === 'string') {
    apiErrorCount++;
    process.stdout.write(` [api-error ${res}]`);
    return { handles: [], rateLimited: false };
  }

  // Rate-limited: wait for the reset window and retry once. Anthropic returns
  // retry-after header; default to 30s which matches a typical ITPM refill window.
  if (res.status === 429 && retryOnRateLimit) {
    const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10);
    process.stdout.write(` [429, waiting ${retryAfter}s]`);
    await new Promise(r => setTimeout(r, retryAfter * 1000));
    return routeQuery(currentMessage, false, record);
  }

  if (!res.ok) {
    // An errored call must be VISIBLE: silently returning ∅ made a rate-limit
    // brownout look like a mass routing regression (2026-08-30, W35).
    apiErrorCount++;
    const errBody = await res.text().catch(() => '');
    process.stdout.write(` [api-error ${res.status}: ${errBody.slice(0, 200)}]`);
    return { handles: [], rateLimited: res.status === 429 };
  }

  const data = await res.json() as { content?: Array<{ type: string; text?: string }>; usage?: Parameters<typeof toStat>[1] };
  if (record) callStats.push(toStat(Date.now() - t0, data.usage));
  const text = data.content?.find(c => c.type === 'text')?.text ?? '';

  // Production's parser (US-15 AC28): prose around the JSON, or a corrected
  // second object, still routes.
  try {
    const parsed = parseRouterReply(text) as { handles?: unknown } | null;
    // No handles list is a router_error in production too (RouterOutput).
    if (!Array.isArray(parsed?.handles)) throw new Error('reply has no handles list');
    const handles = parsed.handles
      .filter((h): h is string => typeof h === 'string' && /^[a-z0-9-]+$/.test(h) && h.length <= 120)
      .map(repairHandle)
      .filter(h => VALID_HANDLES.has(h))
      .slice(0, 3);
    return { handles, rateLimited: false };
  } catch (err) {
    // A reply nothing parses, or one with no handles list, is a router_error in
    // production: count it like an API error, never a silent ∅ (chat-health W41).
    apiErrorCount++;
    process.stdout.write(` [parse-error: ${String((err as Error).message ?? err).slice(0, 100)}]`);
    return { handles: [], rateLimited: false };
  }
}

// ---------------------------------------------------------------------------
// Run each query N times and compute intersection of handles
// ---------------------------------------------------------------------------

interface AnswerCheckResult {
  passed: boolean;
  failures: string[];
  response: string;
}

interface QueryResult {
  query: TestQuery;
  allRuns: string[][];
  intersection: string[];
  routingPassed: boolean;
  forbidden: string[];                   // must_not_route handles any run returned
  answerCheck: AnswerCheckResult | null; // null if not checked
  passed: boolean;
}

/** A failed answer call: its label (a status or a fetch error) and any detail. */
class AnswerApiError extends Error {
  constructor(readonly label: string, detail?: string) { super(detail ? `${label}: ${detail}` : label); }
}

async function checkAnswer(q: TestQuery, matchedHandles: string[] = []): Promise<AnswerCheckResult> {
  const { query, surface } = q;
  const video = YOUTUBE_VIDEOS.get(q);
  const youtube = video && youtubeTurn(video, matchedHandles, query, q.history ?? [], FULL_INDEX);
  const matchedContent = youtube ? youtube.matchedContent : loadMatchedContent(matchedHandles).content;
  // Only production's builder makes the system (US-15 AC24a). The YouTube bot's platform context sits where the
  // widget's user data does (runPipeline); a fixture with no user_context gets production's empty context.
  const platformContext = youtube ? youtube.platformContext : USER_CONTEXTS.get(q) ?? EMPTY_CHAT_CONTEXT.userContextJson;
  const system = buildSystemBlocks(platformContext,
    { surfaceContext: surface && POSTURES.get(surface), savedChat: SAVED_CHATS.get(q) ?? '', blogArticles: matchedContent || null });
  const messages = youtube ? youtube.messages : [...q.history ?? [], { role: 'user' as const, content: query }];
  const body = {
    ...modelParams(ANSWER_MODEL, CHAT_MAX_TOKENS, CHAT_EFFORT),
    system,
    // As production: the tools change what the model writes. The YouTube bot has none (US-15 AC19).
    ...(video ? {} : { tools: chatToolsFor(messages) }),
  };

  // One Messages call; a 429 waits and retries once. As production (callAnthropicWithUsage): thinking makes an answer take 10-20 s.
  const send = async (fields: object) => {
    for (let retry = true; ; retry = false) {
      const t0 = Date.now();
      const res = await postMessages({ ...body, ...fields }, 60_000);
      if (typeof res === 'string') throw new AnswerApiError(res);
      if (res.status === 429 && retry) {
        const retryAfter = parseInt(res.headers.get('retry-after') ?? '30', 10);
        process.stdout.write(` [429, waiting ${retryAfter}s]`);
        await new Promise(r => setTimeout(r, retryAfter * 1000));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new AnswerApiError(String(res.status), text.slice(0, 200).replace(/\s+/g, ' '));
      }
      const data = await res.json() as { content?: ChatContentBlock[]; stop_reason?: string; stop_details?: { category?: string } | null; usage?: Parameters<typeof toStat>[1] };
      answerStats.push(toStat(Date.now() - t0, data.usage));
      return { contentBlocks: data.content ?? [], stopReason: data.stop_reason, category: data.stop_details?.category };
    }
  };

  // As production (getChatCompletion): the same one-round run_roadmap loop, on the payload the widget sends.
  const turn = await withRoadmapRound(messages, send, q.user_context ?? null)
    .catch((err: unknown) => { if (err instanceof AnswerApiError) return err; throw err; });
  if (turn instanceof AnswerApiError) {
    // Count it: a majority vote could otherwise hide one timeout and exit green.
    apiErrorCount++;
    process.stdout.write(` [api-error ${turn.label}]`);
    return { passed: false, failures: [`API error ${turn.message}`], response: '' };
  }
  return scoreAnswer(q, turn);
}

async function runOne(q: TestQuery): Promise<QueryResult> {
  // A fixed-handle answer check skips the router and answers from its own handles.
  const fixed = !Array.isArray(q.expected);
  const allRuns: string[][] = [];
  for (let i = 0; !fixed && i < runs; i++) {
    const { handles } = await routeQuery(q.query);
    allRuns.push(handles);
  }
  const intersection = fixed ? q.answer_handles! : allRuns[0].filter(h => allRuns.every(run => run.includes(h)));

  let routingPassed: boolean;
  if (fixed) {
    routingPassed = true;
  } else if (q.expected.length === 0) {
    routingPassed = allRuns.every(run => run.length === 0);
  } else {
    routingPassed = q.expected.some(e => intersection.includes(e));
  }
  const forbidden = (q.must_not_route ?? []).filter(h => allRuns.some(run => run.includes(h)));
  if (forbidden.length > 0) routingPassed = false;

  let answerCheck: AnswerCheckResult | null = null;
  if (routingPassed && hasAnswerCheck(q)) {
    const answerRuns: AnswerCheckResult[] = [];
    // As production: routed older posts give way to their masters (US-50 AC14); fixed handles load as given.
    const answerHandles = fixed ? intersection : preferMasters(intersection, FULL_INDEX, q.query).handles;
    for (let i = 0; i < answerCheckRuns; i++) {
      answerRuns.push(await checkAnswer(q, answerHandles));
    }
    const passCount = answerRuns.filter(r => r.passed).length;
    const majority = Math.floor(answerCheckRuns / 2) + 1;
    const overallPass = passCount >= majority;
    answerCheck = {
      passed: overallPass,
      failures: overallPass
        ? []
        : answerRuns.flatMap((r, i) => r.passed ? [] : r.failures.map(f => `run ${i + 1}: ${f}`)),
      response: answerRuns[answerRuns.length - 1].response,
    };
  }

  const passed = routingPassed && (answerCheck === null || answerCheck.passed);
  return { query: q, allRuns, intersection, routingPassed, forbidden, answerCheck, passed };
}

export async function runAll(): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  const queue = [...suite];
  let completed = 0;

  async function worker() {
    while (queue.length > 0) {
      const q = queue.shift()!;
      results.push(await runOne(q));
      completed++;
      process.stdout.write(`\r  ${completed}/${suite.length} queries`);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, suite.length) }, () => worker())
  );
  process.stdout.write('\n');

  return results;
}
