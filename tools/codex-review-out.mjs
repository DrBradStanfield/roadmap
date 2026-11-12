// The --out lifecycle for tools/codex-review.mjs (US-40 AC18): a previous run's report never reads as this run's.
// --out is never deleted and never opened for writing. Every write, the first included, creates a temp file beside it
// (exclusive, random name) and renames it over --out: a rename replaces the directory entry and never follows a link.
// Refusals come first, on real paths, with nothing written. Then the exit listener goes in, then "incomplete: run
// started" replaces the old file, so a crash leaves "incomplete", never the old verdict.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lstatSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

const state = { path: null, written: false, why: null };
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (p, root) => p === root || p.startsWith(root + sep);
const incomplete = (summary) => ({ status: "incomplete", summary, findings: [] });

/** Records why the run stopped early, for the report the exit listener writes. */
export function stopReason(why) { state.why = why; }

/** Writes `report` to a new temp file beside --out and renames it into place; the temp file never outlives a failure. */
function replaceOut(report) {
  const tmp = join(dirname(state.path), `.${basename(state.path)}.${randomBytes(8).toString("hex")}.tmp`);
  let created = false;
  try {
    writeFileSync(tmp, JSON.stringify(report, null, 2), { flag: "wx" });
    created = true;
    renameSync(tmp, state.path);
  } catch (e) {
    if (created) rmSync(tmp, { force: true });
    throw e;
  }
}
const cannot = (e) => `--out ${JSON.stringify(state.path)} could not be replaced (${e.code ?? e.message}); the old file at --out may still be there`;

/** Replaces --out with this run's report, if one was claimed. A failure is E_USAGE: it says so and exits 1. */
export function writeOut(report) {
  if (!state.path) return;
  try { replaceOut(report); } catch (e) {
    const why = cannot(e);
    state.path = null;
    console.error(`codex-review: ${why}`);
    process.exit(1);
  }
  state.written = true;
}

function writeStopReport(code) {
  if (!state.path || state.written) return;
  try { replaceOut(incomplete(state.why ?? `E_STOPPED: exit ${code}`)); } catch (e) { console.error(`codex-review: ${cannot(e)}`); }
}

/** Why --out may not be written, or null. `out` is its real path; `inputs` are the paths this run reviews. */
function refusal(out, given, inputs) {
  const said = `--out ${JSON.stringify(given)}`;
  let st = null;
  try { st = lstatSync(out); } catch { /* absent: fine */ }
  if (st && !st.isFile()) return `${said} is not a regular file (a link, folder or other)`;
  const input = inputs.find((p) => inside(out, realOrSelf(p)));
  if (input) return `${said} is inside a reviewed input (${JSON.stringify(input)})`;
  let root;
  try {
    root = realOrSelf(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { return null; } // no checkout here: nothing of it is reviewed
  if (!inside(out, root)) return null;
  const rel = relative(root, out);
  const git = (args) => { try { execFileSync("git", args, { cwd: root, stdio: "ignore" }); return true; } catch { return false; } };
  // icase: on a case-insensitive disk "report.json" is the tracked "Report.json" (a stricter refusal elsewhere is harmless).
  if (git(["ls-files", "--error-unmatch", "--", `:(literal,icase)${rel}`])) return `${said} is tracked in the reviewed checkout`;
  if (!git(["check-ignore", "-q", "--", rel])) return `${said} is inside the reviewed checkout and not gitignored, so it would enter the snapshot`;
  return null;
}

/** Claims --out for this run: null when claimed, else why not (the caller stops with E_USAGE). */
export function claimOut(given, inputs) {
  const out = join(realOrSelf(dirname(resolve(given))), basename(given));
  const why = refusal(out, given, inputs);
  if (why) return why;
  state.path = out;
  process.on("exit", writeStopReport);
  try { replaceOut(incomplete("incomplete: run started")); } catch (e) {
    const failed = cannot(e);
    state.path = null;
    return failed;
  }
  return null;
}
