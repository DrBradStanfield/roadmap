// The --out lifecycle for tools/codex-review.mjs (US-40 AC18): a previous run's report never reads as this run's.
// An --out that is a directory, tracked or otherwise inside the reviewed checkout, or inside a reviewed input is refused
// untouched. Otherwise the exit listener is installed, then the old file is deleted (or, if its folder denies that,
// overwritten), and every way out writes a report: the verdict, "nothing", or "incomplete" with why the run stopped.
import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve, sep } from "node:path";

const state = { path: null, written: false, why: null };
const realOrSelf = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };
const inside = (p, root) => p === root || p.startsWith(root + sep);
const stopReport = () => ({ status: "incomplete", summary: state.why ?? "E_STOPPED: the run did not finish", findings: [] });

/** Records why the run stopped early, for the report the exit listener writes. */
export function stopReason(why) { state.why = why; }

/** Writes this run's report to --out, if one was claimed. A failed write throws. */
export function writeOut(report) {
  if (!state.path) return;
  writeFileSync(state.path, JSON.stringify(report, null, 2));
  state.written = true;
}

function writeStopReport(code) {
  if (!state.path || state.written) return;
  if (!state.why) state.why = `E_STOPPED: exit ${code}`;
  try { writeFileSync(state.path, JSON.stringify(stopReport(), null, 2)); } catch { /* unwritable: the exit code still says it failed */ }
}

/** Why --out may not be replaced, or null. `inputs` are the paths this run reviews beside the checkout. */
function refusal(out, inputs) {
  const said = `--out ${JSON.stringify(out)}`;
  let st = null;
  try { st = lstatSync(out); } catch { /* absent: nothing to replace */ }
  if (st?.isDirectory()) return `${said} is a directory`;
  const abs = resolve(realOrSelf(dirname(resolve(out))), basename(out));
  // An input holding the working folder is refused later as holding the checkout; any other input holding --out is refused here.
  const input = inputs.find((p) => inside(abs, realOrSelf(p)) && !inside(realOrSelf(process.cwd()), realOrSelf(p)));
  if (input) return `${said} is inside a reviewed input (${JSON.stringify(input)})`;
  let root;
  try {
    root = realOrSelf(execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch { return null; } // no checkout here: nothing of it is reviewed
  if (!inside(abs, root)) return null;
  const rel = relative(root, abs);
  const git = (args) => { try { execFileSync("git", args, { cwd: root, stdio: "ignore" }); return true; } catch { return false; } };
  if (git(["ls-files", "--error-unmatch", "--", rel])) return `${said} is tracked in the reviewed checkout`;
  if (!git(["check-ignore", "-q", "--", rel])) return `${said} is inside the reviewed checkout and not gitignored, so it would enter the snapshot`;
  return null;
}

/** Claims --out for this run: null when claimed, else why not (the caller stops with E_USAGE, the file untouched). */
export function claimOut(out, inputs) {
  const why = refusal(out, inputs);
  if (why) return why;
  state.path = out;
  process.on("exit", writeStopReport); // before the file is touched, so no way out leaves the old verdict behind
  try { rmSync(out, { force: true }); } catch {
    try { writeFileSync(out, JSON.stringify(stopReport(), null, 2)); } catch {
      state.path = null;
      return `--out ${JSON.stringify(out)} can be neither deleted nor overwritten`;
    }
  }
  return null;
}
