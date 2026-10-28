// US-48 AC6: the CI Deploy workflow keeps the Shopify CLI at 4.9.4 or newer and
// deploys with --allow-updates. Shopify's server-side app-config check has
// rejected 3.90.0 since 2026-10-26; --force is the old spelling.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const yaml = readFileSync(join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");
const lines = yaml.split("\n").filter((l) => !l.trim().startsWith("#"));
const deployLines = lines.filter((l) => /shopify app deploy/.test(l));

const atLeast = (v: number[], min: number[]) => {
  for (let i = 0; i < 3; i++) if (v[i] !== min[i]) return v[i] > min[i];
  return true;
};

describe("deploy.yml Shopify CLI (US-48 AC6)", () => {
  it("pins @shopify/cli exactly, at 4.9.4 or newer", () => {
    const pins = lines.map((l) => l.match(/@shopify\/cli@(\S+)/)?.[1]).filter(Boolean) as string[];
    expect(pins.length).toBeGreaterThan(0);
    for (const pin of pins) {
      expect(pin).toMatch(/^\d+\.\d+\.\d+$/);
      expect(atLeast(pin.split(".").map(Number), [4, 9, 4])).toBe(true);
    }
  });
  it("both app deploys use --allow-updates, never --force or --allow-deletes", () => {
    expect(deployLines).toHaveLength(2);
    for (const l of deployLines) {
      expect(l).toContain("--allow-updates");
      expect(l).not.toContain("--force");
      expect(l).not.toContain("--allow-deletes");
    }
    expect(lines.join("\n")).not.toMatch(/shopify[^\n]*--force/);
  });
});
