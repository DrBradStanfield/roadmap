// US-46 AC12: workflow-integrity.yml's accepted residual matches deploy.yml.
// The tripwire cancels a tampered run only after it starts. Its header said the
// deploy credentials were safe in those seconds because they sat behind the
// 'production' environment wait timer, which deploy.yml says was removed on
// 2026-09-02. The note must state the residual that holds today.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const read = (f: string) => readFileSync(join(__dirname, "..", ".github", "workflows", f), "utf8");
/** Comment text with each wrapped comment line joined to the one before. */
const prose = (yaml: string) => yaml.replace(/\n\s*#\s*/g, " ");

describe("workflow-integrity residual (US-46 AC12)", () => {
  it("deploy.yml still says the production environment has no wait timer", () => {
    expect(prose(read("deploy.yml"))).toContain("has had no wait timer or required reviewer since 2026-09-02");
  });

  it("the residual does not rest on a production wait timer, and says the deploy secrets are exposed", () => {
    const note = prose(read("workflow-integrity.yml").split("\nname:")[0]);
    expect(note).not.toMatch(/behind the 'production' environment wait timer/);
    expect(note).toMatch(/no wait timer or required reviewer since 2026-09-02/);
    expect(note).toMatch(/can read the deploy secrets/);
  });
});
