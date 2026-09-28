/**
 * Shared --model / --thinking-off plumbing for the router and classifier
 * harnesses, so a candidate model can be A/B'd against the Haiku default on
 * pass rate, latency and cost. Harness-only: production modules are untouched.
 *
 * Sonnet 5.5 rejects (400) the Haiku body shape: no temperature/top_p/top_k,
 * and thinking is on by default at effort high. --thinking-off sends
 * thinking: { type: 'between_tools' } (no other thinking field); otherwise the
 * arm keeps adaptive thinking at output_config.effort 'low', where max_tokens
 * caps thinking + answer together, so it is raised to 1024.
 */

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

const isSonnet55 = (model: string) => model.startsWith('claude-sonnet-5-5');
// Sonnet 5 and later (and every Opus/Fable 5) 400 on non-default sampling
// params; only Haiku 4.5 and older take temperature. Priced at Sonnet rates.
const isSonnet5Family = (model: string) => /^claude-sonnet-5(-|$)/.test(model);

/** Model + sampling fields of the request body for this arm. */
export function modelParams(model: string, maxTokens: number, thinkingOff: boolean): Record<string, unknown> {
  if (!isSonnet5Family(model)) return { model, max_tokens: maxTokens, temperature: 0 };
  // between_tools is Sonnet 5.5-only; Sonnet 5 turns thinking off with `disabled`.
  if (thinkingOff) return { model, max_tokens: maxTokens, thinking: { type: isSonnet55(model) ? 'between_tools' : 'disabled' } };
  return { model, max_tokens: 1024, output_config: { effort: 'low' } };
}

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
