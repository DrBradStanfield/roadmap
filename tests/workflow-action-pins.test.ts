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
