// US-40 AC16: the CI reviewer reads untrusted PR text, so its claude_args deny
// every way to run code, write files, push or read the token the action writes
// into .git/config, and only Brad's and the reviewer's own PR comments reach it.
// The action's tag mode allows Bash(git ...) and acceptEdits itself, so the
// deny list is what holds the boundary: a test that the lines are still there.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const yaml = readFileSync(join(__dirname, "..", ".github", "workflows", "claude-review.yml"), "utf8");
const arg = (flag: string) => {
  const m = yaml.match(new RegExp(`^\\s*${flag} "([^"]*)"\\s*$`, "m"));
  expect(m, `${flag} line`).not.toBeNull();
  return m![1].split(",");
};

describe("CI reviewer boundary (US-40 AC16)", () => {
  it("denies shell, file writes and reading .git", () => {
    expect(arg("--disallowedTools")).toEqual(["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "Read(./.git/**)"]);
  });
  it("allows only read tools and the verdict comment", () => {
    expect(arg("--allowedTools")).toEqual(["Read", "Grep", "Glob", "mcp__github_comment__update_claude_comment"]);
  });
  it("reads PR comments from Brad and the reviewer only", () => {
    expect(yaml).toMatch(/^\s*include_comments_by_actor: "DrBradStanfield,claude\[bot\]"\s*$/m);
  });
  it("keeps the action pinned and never sets allowed_non_write_users", () => {
    expect(yaml).toContain("anthropics/claude-code-action@6d5ae526d25ce88daa2200be073e1a373167f064");
    expect(yaml).not.toMatch(/^\s*allowed_non_write_users:/m);
  });
});
