// US-48 AC8: an action from outside GitHub's own `actions/` organisation runs
// only at a full commit SHA, with the version it stands for in a comment. A tag
// such as `@v1` can be moved by whoever controls that repo, and the next run
// takes the new code with this job's secrets and write tokens.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DIR = join(__dirname, "..", ".github", "workflows");
const uses = readdirSync(DIR)
  .filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) =>
    readFileSync(join(DIR, f), "utf8")
      .split("\n")
      .map((line, i) => ({ where: `${f}:${i + 1}`, line, m: line.match(/^\s*(?:-\s*)?uses:\s*([^\s@#]+)@(\S+)(.*)$/) }))
      .filter((u) => u.m),
  );
const thirdParty = uses.filter((u) => !u.m![1].startsWith("actions/"));

describe("third-party actions are pinned to a commit (US-48 AC8)", () => {
  it("finds the third-party actions to check (guards against a silently empty assertion)", () => {
    expect(thirdParty.map((u) => u.m![1])).toEqual(
      expect.arrayContaining(["anthropics/claude-code-action", "superfly/flyctl-actions/setup-flyctl"]),
    );
  });

  it.each(thirdParty)("$where uses a full commit SHA with a version comment", (u) => {
    expect(u.m![2], u.line).toMatch(/^[0-9a-f]{40}$/);
    expect(u.m![3], u.line).toMatch(/^\s+#\s*v\d/);
  });
});

// US-48 AC8a: the two workflows that hold deploy and reviewer secrets pin GitHub's
// own actions too, at the commits the newer workflows already use.
describe("the secret-bearing workflows pin every action to a commit (US-48 AC8a)", () => {
  const SECRET_BEARING = ["deploy.yml", "claude-review.yml"];
  const inFile = (f: string) => uses.filter((u) => u.where.startsWith(`${f}:`));

  it("finds every uses: line in both files (guards against a silently empty assertion)", () => {
    expect(inFile("deploy.yml").length).toBe(7);
    expect(inFile("claude-review.yml").length).toBe(2);
    expect(SECRET_BEARING.flatMap(inFile).map((u) => u.m![1])).toEqual(expect.arrayContaining(["actions/checkout", "actions/setup-node"]));
  });

  it.each(SECRET_BEARING.flatMap(inFile))("$where uses a full commit SHA with a version comment", (u) => {
    expect(u.m![2], u.line).toMatch(/^[0-9a-f]{40}$/);
    expect(u.m![3], u.line).toMatch(/^\s+#\s*v\d/);
  });

  it("uses the same commit and version comment as the newer workflows for each GitHub action", () => {
    const ref = (u: (typeof uses)[number]) => `${u.m![2]}${u.m![3]}`;
    const NEWER = ["engine-release.yml", "ci-shuffle.yml", "ios-compile.yml"];
    const newer = NEWER.flatMap(inFile);
    for (const u of SECRET_BEARING.flatMap(inFile).filter((x) => x.m![1].startsWith("actions/"))) {
      const same = newer.filter((n) => n.m![1] === u.m![1]).map(ref);
      expect(same.length, `${u.m![1]} in the newer workflows`).toBeGreaterThan(0);
      expect(same, u.where).toContain(ref(u));
    }
  });
});
