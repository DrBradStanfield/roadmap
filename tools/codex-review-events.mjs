// Reading the codex event stream (JSONL on stdout) for tools/codex-review.mjs: kept metadata, search hostnames, and
// what an exit 1 shows. Side-effect free. Spec: US-40 AC5, AC14, AC18.
import { PATTERNS } from "./secret-rules.mjs";

/** Each JSONL line that parses as an object; anything else is skipped. */
function parseEvents(jsonl) {
  return jsonl.split("\n").flatMap((line) => {
    try {
      const ev = JSON.parse(line);
      return ev && typeof ev === "object" ? [ev] : [];
    } catch { return []; }
  });
}

/**
 * A web_search event's result and opened-page hostnames (AC14): never a query, a path, a query string or any text.
 * null, not [], when the event yields no hostname: some hosted searches report only the action, with no results or URL
 * (Codex R1 on 132431c8), and an empty list would read as "no sources" when the truth is "sources unknown".
 */
export function searchDomains(it) {
  const host = (u) => { try { return new URL(u).hostname; } catch { return null; } };
  const raw = [
    ...(Array.isArray(it.results) ? it.results.flatMap((r) => [r?.domain, host(r?.url)]) : []),
    host(it.action?.url),
  ];
  const hosts = [...new Set(raw.filter((d) => typeof d === "string" && /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(d) && d.length <= 253).map((d) => d.toLowerCase()))].sort();
  return hosts.length ? hosts : null;
}

/** Diagnostic metadata only: tool arguments, results, and message text never persist (a live record may be in them). */
export function eventMetadata(jsonl) {
  return jsonl.split("\n").flatMap((line) => {
    try {
      const ev = JSON.parse(line);
      const it = ev.item ?? {};
      const search = it.type === "web_search" ? { action: typeof it.action?.type === "string" && /^[a-z_]{1,32}$/.test(it.action.type) ? it.action.type : null, domains: searchDomains(it) } : {};
      return [JSON.stringify({ type: ev.type, item: it.type, server: it.server, tool: it.tool, status: it.status, error: it.error == null ? null : "error", ...search })];
    } catch { return []; }
  }).join("\n");
}

const MESSAGE_LIMIT = 200;
/** A known credential shape (US-40 AC11's PATTERNS) and the token characters after it: an error may echo a masked key. */
const CREDENTIAL = new RegExp(`(?:${Object.values(PATTERNS).join("|")})[A-Za-z0-9_./+-]*`, "g");

/**
 * The last `error` event's message: Codex's own text, so data, never instructions. One line (control, format and
 * line-separator characters collapse to a space), credential shapes redacted, at most 200 characters. null when no
 * error event carries one.
 */
export function lastErrorMessage(events) {
  const last = events.filter((ev) => ev.type === "error" && typeof ev.message === "string").at(-1);
  if (!last) return null;
  const line = last.message.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ").replace(/ {2,}/g, " ").trim().replace(CREDENTIAL, "[redacted]");
  return [...line].slice(0, MESSAGE_LIMIT).join("");
}

/**
 * What a codex exit 1 shows (AC18). The tool reports what it saw, never a cause it cannot prove: an expired login, a
 * wrong model id or a dropped connection may also end `turn.started -> error`, so that tail is E_EXIT_1 as a hint only.
 * Any other exit 1 is E_CODEX_FAILED. Both are incomplete, and neither is a pass.
 */
export function exitOneOutcome(stdout) {
  const events = parseEvents(stdout);
  const tail = events.slice(-2).map((ev) => ev.type).join(" -> ");
  const message = lastErrorMessage(events);
  const said = message === null ? "Codex gave no error message." : `Codex error: "${message}"`;
  const summary = tail === "turn.started -> error"
    ? `E_EXIT_1: codex exited 1; events end turn.started -> error (a hint only: read the error message before waiving). ${said}`
    : `E_CODEX_FAILED: codex exited 1 without that tail; not a pass. ${said}`;
  return { summary, codexError: message };
}
