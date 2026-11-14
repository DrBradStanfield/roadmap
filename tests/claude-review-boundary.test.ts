// US-40 AC16: the CI reviewer reads untrusted PR text, so its effective tool
// policy must hold no way to run code, write files, push, fetch from the web or
// read a secret, and only Brad's and the reviewer's own PR comments reach it.
// The action's tag mode grants tools itself and our claude_args are appended
// after, so the test computes what survives: tag mode's grants (fixture below)
// plus our allow list, minus our deny list (a deny beats an allow).
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Fixture: anthropics/claude-code-action at this SHA. When the pin moves,
// re-read the cited lines and update this fixture before changing PINNED_SHA.
const PINNED_SHA = "6d5ae526d25ce88daa2200be073e1a373167f064";
const TAG_MODE = {
  // src/modes/tag/index.ts:161-171 (always granted; plus any mcp__github_* in our allow list)
  base: ["Glob", "Grep", "LS", "Read", "mcp__github_comment__update_claude_comment",
    "mcp__github_ci__get_ci_status", "mcp__github_ci__get_workflow_run_details", "mcp__github_ci__download_job_log"],
  // :175-182, git CLI signing (the default)
  gitCli: ["Bash(git add:*)", "Bash(git commit:*)", "Bash(/action/scripts/git-push.sh:*)", "Bash(git rm:*)"],
  // :183-188, API commit signing
  apiSigning: ["mcp__github_file_ops__commit_files", "mcp__github_file_ops__delete_files"],
  // :214, --permission-mode acceptEdits: file edits inside the workspace need no allow rule
  acceptEdits: ["Edit", "MultiEdit", "Write", "NotebookEdit"],
};
const READ_ONLY = new Set(TAG_MODE.base);

const yaml = readFileSync(join(__dirname, "..", ".github", "workflows", "claude-review.yml"), "utf8");
const arg = (flag: string) => {
  const m = yaml.match(new RegExp(`^\\s*${flag} "([^"]*)"\\s*$`, "m"));
  expect(m, `${flag} line`).not.toBeNull();
  return m![1].split(",");
};
const allow = arg("--allowedTools");
const deny = arg("--disallowedTools");

// A bare deny ("Bash") removes the tool and every scoped rule for it
// ("Bash(git add:*)"); a scoped deny ("Read(./.git/**)") only narrows the tool.
const name = (rule: string) => rule.replace(/\(.*$/, "");
const denied = (rule: string, list: string[]) => list.some((d) => !d.includes("(") && d === name(rule));
const effective = (branch: string[], list: string[] = deny) =>
  [...new Set([...TAG_MODE.base, ...branch, ...TAG_MODE.acceptEdits, ...allow])].filter((t) => !denied(t, list));

describe("CI reviewer boundary (US-40 AC16)", () => {
  it("the fixture matches the pinned action (re-check it when the pin moves)", () => {
    expect(yaml).toContain(`anthropics/claude-code-action@${PINNED_SHA}`);
  });

  for (const [label, branch] of [["git CLI signing", TAG_MODE.gitCli], ["API commit signing", TAG_MODE.apiSigning]] as const) {
    it(`with ${label}, only read-only tools and the verdict comment survive`, () => {
      const left = effective([...branch]);
      for (const t of left) {
        expect(name(t), t).not.toMatch(/^(Bash|Edit|MultiEdit|Write|NotebookEdit|WebFetch|WebSearch)$|^mcp__github_file_ops__/);
        expect(READ_ONLY.has(t), `${t} is not a read-only tag-mode tool`).toBe(true);
      }
      expect(left).toContain("mcp__github_comment__update_claude_comment");
    });
  }

  it("the old deny list let file_ops survive (the test has teeth)", () => {
    const old = ["Bash", "Edit", "MultiEdit", "Write", "NotebookEdit", "Read(./.git/**)"];
    expect(effective(TAG_MODE.apiSigning, old)).toContain("mcp__github_file_ops__commit_files");
  });

  it("WebFetch and WebSearch are denied outright (the action's fixture never lists them, so effective() cannot catch their removal)", () => {
    expect(deny).toEqual(expect.arrayContaining(["WebFetch", "WebSearch"]));
  });

  it("Read cannot reach the token in .git or the process environment", () => {
    expect(deny).toEqual(expect.arrayContaining(["Read(./.git/**)", "Read(//proc/**)"]));
  });

  it("our allow list adds nothing tag mode does not already grant read-only", () => {
    for (const t of allow) expect(READ_ONLY.has(t), t).toBe(true);
  });

  it("reads PR comments from Brad and the reviewer only", () => {
    expect(yaml).toMatch(/^\s*include_comments_by_actor: "DrBradStanfield,claude\[bot\]"\s*$/m);
  });

  it("never sets allowed_non_write_users", () => {
    expect(yaml).not.toMatch(/^\s*allowed_non_write_users:/m);
  });
});

// US-40 AC16a: the prompt tells the reviewer what its verdict does. auto-ship.yml
// can merge a claude/* PR on an APPROVE for its head sha, so the prompt must not
// call the verdict advisory or name a human approver the pipeline no longer has.
describe("the reviewer's prompt states what its verdict does (US-40 AC16a)", () => {
  const prompt = (() => {
    const m = yaml.match(/^(\s*)prompt: \|\n([\s\S]*?)^\s*claude_args:/m);
    expect(m, "prompt block").not.toBeNull();
    return m![2].replace(/\s+/g, " ");
  })();

  it("reads the model-facing prompt (guards against an empty match)", () => {
    expect(prompt).toContain("You are the INDEPENDENT REVIEWER");
    expect(prompt).toContain("VERDICT: APPROVE");
  });

  it("does not call the verdict advisory or name a human approver", () => {
    expect(prompt).not.toMatch(/advisory comment|human approver/i);
    expect(prompt).not.toMatch(/(?<!not )advisory/i);
  });

  it("says the verdict is not advisory and that auto-ship can merge on an APPROVE, after a veto window", () => {
    expect(prompt).toContain("Your verdict is not advisory");
    expect(prompt).toMatch(/auto-ship\.yml can merge this PR on your APPROVE for its head sha/);
    expect(prompt).toMatch(/30-minute veto window/);
    expect(prompt).toMatch(/no human approves it first/);
  });

  it("agrees with the workflow header", () => {
    expect(yaml).toMatch(/^# as a comment\. It is not advisory: auto-ship\.yml merges a claude\/\* PR on this$/m);
  });
});
