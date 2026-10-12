/**
 * US-15 AC28: a router reply that holds a second, corrected JSON object routes
 * on the correction instead of failing the turn (production, 2026-10-07).
 */
import { describe, it, expect } from 'vitest';
import { parseRouterReply } from './router-reply';
import { extractJsonObject } from '../../packages/health-core/src/lab-extraction';

// The production reply, 2026-10-07 (YouTube).
const PROD_1007 = '{"handles": ["diet", "this-study-proved-we-were-wrong-about-vitamin-d"]}\n\nWait — correction. The second handle was a mistake; returning only the relevant ones:\n\n{"handles": ["diet", "best-diet-confirmed-by-5248916-person-year-study", "diet-strongly-suspected-best"]}';
// The harness shape, 2026-10-11 (chat-health W41, L3 run 3).
const HARNESS_1011 = '{"handles": ["guideline-diet"]}\n\nCorrection: copying handles exactly from the index (without the type label):\n\n{"handles": ["diet"]}';

/** Today's behaviour: the first `{` to the last `}`, parsed whole. */
const before = (text: string) => JSON.parse(extractJsonObject(text)) as unknown;

describe('US-15 AC28: parseRouterReply takes the correction', () => {
  it('the 2026-10-07 production reply routes on the second object', () => {
    expect(() => before(PROD_1007)).toThrow(/Unexpected non-whitespace character after JSON/);
    expect(parseRouterReply(PROD_1007)).toEqual({
      handles: ['diet', 'best-diet-confirmed-by-5248916-person-year-study', 'diet-strongly-suspected-best'],
    });
  });

  it('the "Correction: copying handles" reply routes on the second object', () => {
    expect(() => before(HARNESS_1011)).toThrow();
    expect(parseRouterReply(HARNESS_1011)).toEqual({ handles: ['diet'] });
  });

  it('a single object parses exactly as before, with or without prose and fences', () => {
    for (const text of [
      '{"handles":["diet"]}',
      '  {"handles": []}\n',
      '```json\n{"handles":["diet","sleep"]}\n```',
      'Here you go: {"handles":["diet"]} — the diet guideline fits best.',
      '{"handles":["diet"],"meta":{"why":"a } brace"}}',
    ]) expect(parseRouterReply(text)).toEqual(before(text));
  });

  it('a reply with no object, or none that parses, throws the error it throws today', () => {
    for (const text of ['Hi there, how can I help?', '', '{"handles": ["diet"', '{not json} and {nor this}']) {
      let today: unknown;
      try { before(text); } catch (err) { today = err; }
      expect(today).toBeInstanceOf(SyntaxError);
      expect(() => parseRouterReply(text)).toThrow((today as Error).message);
    }
  });

  it('a brace inside a string does not split or join objects', () => {
    // A brace-blind scan sees the "{" in the first string as an open object,
    // so neither object closes at the top level and nothing would parse.
    const text = '{"handles":["guideline-diet"],"note":"a { stray"}\nCorrection:\n{"handles":["diet"],"note":"ok \\"}\\" done"}';
    expect(parseRouterReply(text)).toEqual({ handles: ['diet'], note: 'ok "}" done' });
  });

  it('uses the last object that parses, skipping a later one that does not', () => {
    expect(parseRouterReply('{"handles":["diet"]}\nNote: {not json}')).toEqual({ handles: ['diet'] });
  });
  it('a later object with no handles list never overrides the answer', () => {
    for (const tail of ['{"note":"x"}', '{}', '{"result":{"handles":["sleep"]}}']) {
      expect(parseRouterReply(`{"handles":["diet"]}\n${tail} }`)).toEqual({ handles: ['diet'] });
    }
  });

  it('with no handles object at all, it throws the error it throws today', () => {
    const text = '{"note":"x"}\n{"other":1}';
    let today: unknown;
    try { before(text); } catch (err) { today = err; }
    expect(() => parseRouterReply(text)).toThrow((today as Error).message);
  });
});
