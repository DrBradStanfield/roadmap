import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// tools/test-queries.json is a PUBLIC fixture, and its production cases come
// from real people. The chat-health charter requires paraphrase on ingest;
// this test is the mechanical floor under that rule.

const FIXTURE = fileURLToPath(new URL("./test-queries.json", import.meta.url));

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/;
const URL_WITH_QUERY = /https?:\/\/[^\s"']*\?[^\s"']+/;
const AT_HANDLE = /(?:^|[\s([<"'])@[A-Za-z0-9_][A-Za-z0-9_.]{2,}/;
// Dates carry 8 digits and are not personal; strip them before looking for
// a phone-shaped run of 7 or more digits (separators allowed).
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}\b/g;
const PHONE_SHAPED = /\d[\d\s().+-]{5,}\d/g;

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const v of value) strings(v, out);
  else if (value && typeof value === "object")
    for (const v of Object.values(value)) strings(v, out);
  return out;
}

function violations(text: string): string[] {
  const found: string[] = [];
  if (EMAIL.test(text)) found.push("email address");
  if (URL_WITH_QUERY.test(text)) found.push("URL with a query string");
  if (AT_HANDLE.test(text)) found.push("@handle");
  const dateless = text.replace(ISO_DATE, "");
  for (const run of dateless.match(PHONE_SHAPED) ?? []) {
    if (run.replace(/\D/g, "").length >= 7) found.push(`phone-shaped run "${run.trim()}"`);
  }
  return found;
}

const entries = JSON.parse(readFileSync(FIXTURE, "utf8")) as unknown[];

describe("tools/test-queries.json carries no personal identifiers", () => {
  it("has entries to check", () => {
    expect(Array.isArray(entries)).toBe(true);
    expect(entries.length).toBeGreaterThan(0);
  });

  it.each(entries.map((entry, index) => [index, entry] as const))(
    "entry %i is clean",
    (index, entry) => {
      const problems = strings(entry).flatMap((text) =>
        violations(text).map((what) => `${what} in ${JSON.stringify(text.slice(0, 120))}`),
      );
      expect(problems, `entry ${index}: paraphrase on ingest (chat-health charter)`).toEqual([]);
    },
  );
});
