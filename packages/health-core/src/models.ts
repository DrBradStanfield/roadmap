/**
 * The one source of truth for which Claude model each hop runs on, and for the
 * request fields that depend on the model family. Server code deep-imports this
 * file; the harnesses import it so they test the model production runs.
 *
 * BYOK chat (widget-src/src/lib/byok-chat.ts) is NOT pinned here on purpose: the
 * user pays for it, so it stays on Haiku.
 */

/** Main chat answer (web, Discord, YouTube). */
export const CHAT_MODEL = 'claude-sonnet-5-5';
/** Retrieval router: a handle list. */
export const ROUTER_MODEL = 'claude-haiku-4-5-20251001';
/** Pre-router classifier: a one-word label. */
export const CLASSIFIER_MODEL = 'claude-haiku-4-5-20251001';
/** Lab/document extraction, server and BYOK upload paths alike. */
export const EXTRACTION_MODEL = 'claude-haiku-4-5-20251001';

/** The main answer's request shape: `max_tokens` caps thinking plus answer together. */
export const CHAT_MAX_TOKENS = 4096;
export const CHAT_EFFORT: Effort = 'medium';

export type Effort = 'low' | 'medium' | 'high';

const isSonnet55 = (model: string) => model.startsWith('claude-sonnet-5-5');
// Sonnet 5 and later 400 on non-default sampling params; only Haiku 4.5 and
// older take temperature. Priced at Sonnet rates below.
const isSonnet5Family = (model: string) => /^claude-sonnet-5(-|$)/.test(model);

/**
 * Model, max_tokens, sampling and thinking fields of a request body.
 *
 * Haiku 4.5: `temperature: 0`; `thinking` is ignored.
 * Any other family throws: a guessed shape would 400 or change behaviour.
 * Sonnet 5 family: never a sampling param. `'off'` sends
 * `{type: 'between_tools'}` on 5.5 (it 400s on `disabled`) and
 * `{type: 'disabled'}` on Sonnet 5; neither takes another thinking field.
 * An effort level sends adaptive thinking with `output_config.effort`, and
 * raises `max_tokens` to at least 1024 because it caps thinking plus answer.
 */
export function modelParams(model: string, maxTokens: number, thinking: 'off' | Effort = 'off'): Record<string, unknown> {
  if (model.startsWith('claude-haiku-4-5')) return { model, max_tokens: maxTokens, temperature: 0 };
  if (!isSonnet5Family(model)) throw new Error(`modelParams: no request shape for ${model}`);
  if (thinking === 'off') return { model, max_tokens: maxTokens, thinking: { type: isSonnet55(model) ? 'between_tools' : 'disabled' } };
  return {
    model,
    max_tokens: Math.max(maxTokens, 1024),
    thinking: { type: 'adaptive', display: 'summarized' },
    output_config: { effort: thinking },
  };
}

// ---------------------------------------------------------------------------
// Harness plumbing (tools/test-*.ts): flags, per-call stats, one summary line.
// ---------------------------------------------------------------------------

/**
 * `--flag value` lookup with a default. An absent flag must fall back to its
 * default: the classifier harness once read `args[args.indexOf(flag) + 1]`,
 * which is args[0] when the flag is absent, so `--runs 1` alone made
 * concurrency NaN, started zero workers and printed a vacuous pass.
 */
export function getArg(args: string[], flag: string, defaultValue: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 && args[idx + 1] ? args[idx + 1] : defaultValue;
}

export interface CallStat {
  ms: number;
  input: number;
  cacheRead: number;
  cacheWrite: number;
  output: number;
}

interface Usage {
  input_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

// $ per million tokens. Figures supplied with the 2026-09-29 comparison task.
const PRICES = {
  haiku: { input: 1, output: 5, cacheRead: 0.10, cacheWrite: 1.25 },
  sonnet55: { input: 2, output: 10, cacheRead: 0.20, cacheWrite: 2.50 },
};

export function toStat(ms: number, u: Usage | undefined): CallStat {
  return {
    ms,
    input: u?.input_tokens ?? 0,
    cacheRead: u?.cache_read_input_tokens ?? 0,
    cacheWrite: u?.cache_creation_input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
  };
}

function pct(sorted: number[], p: number): number {
  return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] : 0;
}

/** One-line run summary: pass rate, n, latency, tokens by class, estimated cost. */
export function summaryLine(label: string, model: string, thinkingOff: boolean, pass: number, n: number, stats: CallStat[], apiErrors: number): string {
  const ms = stats.map(s => s.ms).sort((a, b) => a - b);
  const sum = (k: keyof CallStat) => stats.reduce((t, s) => t + s[k], 0);
  const tok = { input: sum('input'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite'), output: sum('output') };
  const p = isSonnet5Family(model) ? PRICES.sonnet55 : PRICES.haiku;
  const cost = (tok.input * p.input + tok.output * p.output + tok.cacheRead * p.cacheRead + tok.cacheWrite * p.cacheWrite) / 1e6;
  const arm = isSonnet5Family(model) ? (thinkingOff ? 'thinking-off' : 'effort-low') : 'temp0';
  return `SUMMARY ${label} model=${model} arm=${arm} pass=${pass}/${n} (${(100 * pass / n).toFixed(1)}%) ` +
    `calls=${stats.length} apiErrors=${apiErrors} p50=${pct(ms, 0.5)}ms p90=${pct(ms, 0.9)}ms ` +
    `tokens in=${tok.input} cacheRead=${tok.cacheRead} cacheWrite=${tok.cacheWrite} out=${tok.output} ` +
    `cost=$${cost.toFixed(4)} per1000calls=$${stats.length ? (1000 * cost / stats.length).toFixed(3) : '0'}`;
}
