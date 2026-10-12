/**
 * Parse the router model's reply (US-15 AC28). Pure, Sentry-free and free of
 * the Remix import chain, so the router harness (tools/test-chatbot-matching.ts)
 * runs this same code.
 *
 * The reply is parsed from its first `{` to its last `}`, as before. When that
 * fails, the model may have corrected itself: on 2026-10-07 the router sent
 * JSON, then "Wait — correction", then a second object, and the turn got no
 * handles. So the reply is scanned for its top-level `{…}` objects, braces
 * inside JSON strings not counted, and the last one that parses wins. If none
 * parses, the first error is thrown, so router_error is unchanged.
 */
import { extractJsonObject } from '../../packages/health-core/src/lab-extraction';

export function parseRouterReply(text: string): unknown {
  try {
    return JSON.parse(extractJsonObject(text));
  } catch (err) {
    const objects: string[] = [];
    let depth = 0, start = 0, inString = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (c === '\\') escaped = true;
        else if (c === '"') inString = false;
      } else if (c === '"' && depth > 0) inString = true;
      else if (c === '{' && depth++ === 0) start = i;
      else if (c === '}' && depth > 0 && --depth === 0) objects.push(text.slice(start, i + 1));
    }
    for (const candidate of objects.reverse()) {
      try { return JSON.parse(candidate); } catch { /* try the one before */ }
    }
    throw err;
  }
}
