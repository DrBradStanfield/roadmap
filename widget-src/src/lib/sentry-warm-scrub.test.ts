// @vitest-environment jsdom
/**
 * US-09 AC57: the free-text scrub's first use compiles its patterns, so the
 * widget pays that once the page is idle, not on the first report. The
 * warm-up changes no pattern and leaves no state behind: the scrub's output
 * is the same with or without it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const init = vi.hoisted(() => vi.fn());
vi.mock('@sentry/react', async (original) => ({ ...(await original<typeof import('@sentry/react')>()), init }));
const scrubCalls = vi.hoisted(() => [] as string[]);
vi.mock('@roadmap/health-core/sentry-scrub', async (original) => {
  const real = await original<typeof import('@roadmap/health-core/sentry-scrub')>();
  return { ...real, scrubText: (text: string) => { scrubCalls.push(text); return real.scrubText(text); } };
});

declare const jsdom: { reconfigure: (o: { url: string }) => void };
type Idle = (cb: () => void, opts?: { timeout?: number }) => number;
const win = window as unknown as { requestIdleCallback?: Idle };

beforeEach(() => { init.mockClear(); scrubCalls.length = 0; vi.resetModules(); });
afterEach(() => { delete win.requestIdleCallback; vi.useRealTimers(); });

async function initOn(url: string) {
  jsdom.reconfigure({ url });
  const { initSentry } = await import('./sentry');
  initSentry();
}

describe('US-09 AC57 — the scrub compiles at idle, not on the first report', () => {
  it('on the live site, the first scrub runs in an idle callback after init, not during it', async () => {
    const idle = vi.fn<Idle>(() => 1);
    win.requestIdleCallback = idle;
    await initOn('https://drstanfield.com/pages/roadmap');
    expect(scrubCalls).toEqual([]);
    expect(idle).toHaveBeenCalledTimes(1);
    idle.mock.calls[0][0]();
    expect(scrubCalls).toEqual(['x']);
  });

  it('with no requestIdleCallback (Safari), a timer runs it', async () => {
    vi.useFakeTimers();
    await initOn('https://drstanfield.com/pages/roadmap');
    expect(scrubCalls).toEqual([]);
    await vi.runAllTimersAsync();
    expect(scrubCalls).toEqual(['x']);
  });

  it('on a loopback host, where Sentry is off, nothing is scheduled', async () => {
    vi.useFakeTimers();
    const idle = vi.fn<Idle>(() => 1);
    win.requestIdleCallback = idle;
    await initOn('http://localhost:5174/');
    await vi.runAllTimersAsync();
    expect(idle).not.toHaveBeenCalled();
    expect(scrubCalls).toEqual([]);
  });
});

describe('US-09 AC57 — the warm-up changes no scrub output', () => {
  // Synthetic numbers only. Each catalogue word in the contexts the scrub's own
  // tests use: case, punctuation, a number glued on, before and after, unicode edges.
  const contexts = (w: string) => [
    `${w} 5.2`, `${w.toUpperCase()}: 5.2`, `${w}=5.2;`, `${w}5.2`, `5.2 ${w}`, `(5.2 ${w}s)`,
    `x${w} 5.2`, `${w}, pending ${w} 5.2`, `${w} 140/90`, `γ-${w} 5.2`, `${w}é 5.2`, `5,2 ${w}\n3`,
    `${w} 5.2 mmol/L and a@b.com`, `https://a.invalid/${w}%205.2`,
  ];

  it('a cold scrub and a warmed one give the same output on every word in every context', async () => {
    const vocab = await import('@roadmap/health-core/scrub-vocabulary');
    const corpus = vocab.SCRUB_METRIC_WORDS.flatMap(contexts);
    expect(corpus.length).toBeGreaterThan(1000);

    vi.resetModules();
    const cold = await import('@roadmap/health-core/sentry-scrub');
    const coldOut = corpus.map((s) => [cold.scrubText(s), cold.firstScrubbedValue(s)]);

    vi.resetModules();
    const idle = vi.fn<Idle>(() => 1);
    win.requestIdleCallback = idle;
    await initOn('https://drstanfield.com/pages/roadmap');
    idle.mock.calls[0][0]();
    const warmVocab = await import('@roadmap/health-core/scrub-vocabulary');
    for (const re of [warmVocab.EMAIL_RE, warmVocab.UNIT_VALUE_RE, warmVocab.METRIC_THEN_VALUE_RE, warmVocab.VALUE_THEN_METRIC_RE]) {
      expect(re.lastIndex).toBe(0);
    }
    const warm = await import('@roadmap/health-core/sentry-scrub');
    expect(corpus.map((s) => [warm.scrubText(s), warm.firstScrubbedValue(s)])).toEqual(coldOut);
  });
});
