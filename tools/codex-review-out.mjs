// The --out lifecycle for tools/codex-review.mjs (US-40 AC18): a previous run's report never reads as this run's.
// --out is never deleted and never opened for writing. Every write, the first included, creates a temp file beside it
// (exclusive, random name) and renames it over --out: a rename replaces the directory entry and never follows a link.
// Refusals come first, with nothing written. The rule is ownership, not names: only an empty file or a report this tool
// wrote is ever replaced. Overlap with a reviewed input is judged by (dev, ino), never by spelling, so letter case,
// Unicode form and symlink aliases cannot slip past it. Then the exit listener goes in, then "incomplete: run started"
// replaces the old file, so a crash leaves "incomplete", never the old verdict.
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const state = { path: null, written: false, why: null };
const REPORT_CAP = 8 * 1024 * 1024; // a prior report is read whole; anything bigger is not ours
const incomplete = (summary) => ({ status: "incomplete", summary, findings: [] });
/** A path's identity, "dev:ino" (bigint, so nothing rounds), or null when it does not stat. */
const identity = (p) => { try { const s = statSync(p, { bigint: true }); return `${s.dev}:${s.ino}`; } catch { return null; } };
/** `dir` and every folder above it, up to and including the root. */
const ancestors = (dir) => { const all = [dir]; while (dirname(all.at(-1)) !== all.at(-1)) all.push(dirname(all.at(-1))); return all; };

/** Records why the run stopped early, for the report the exit listener writes. */
export function stopReason(why) { state.why = why; }

/** Writes `report` to a new temp file beside --out and renames it into place; the temp file never outlives a failure. */
function replaceOut(report) {
  const tmp = join(dirname(state.path), `.${basename(state.path)}.${randomBytes(8).toString("hex")}.tmp`);
  try { writeFileSync(tmp, JSON.stringify(report, null, 2), { flag: "wx" }); } catch (e) {
    if (e.code !== "EEXIST") rmSync(tmp, { force: true }); // EEXIST: that name was never ours
    throw e;
  }
  try { renameSync(tmp, state.path); } catch (e) { rmSync(tmp, { force: true }); throw e; }
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

/** The first reviewed input that IS `out` or one of the folders above it, by identity, or null. Inputs that do not stat are skipped. */
export function overlap(out, inputs) {
  const mine = new Set([out, ...ancestors(dirname(out))].map(identity).filter(Boolean));
  return inputs.find((p) => mine.has(identity(p))) ?? null;
}

/** True when the regular file at `out` is empty or a report this tool wrote; read without following a link, under a cap. */
function ours(out) {
  let fd;
  try { fd = openSync(out, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return false; }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > REPORT_CAP) return false;
    if (st.size === 0) return true;
    const buf = Buffer.alloc(st.size);
    let n = 0;
    for (let got; n < st.size && (got = readSync(fd, buf, n, st.size - n, n)); n += got);
    const v = JSON.parse(buf.subarray(0, n).toString("utf8"));
    return !!v && typeof v === "object" && !Array.isArray(v) && ["complete", "incomplete", "nothing"].includes(v.status) && Array.isArray(v.findings);
  } catch { return false; } finally { closeSync(fd); }
}

/** Why --out may not be written, or null. `out` sits in the real folder `parent`; `inputs` are the raw paths this run reviews. */
function refusal(out, parent, given, inputs) {
  const said = `--out ${JSON.stringify(given)}`;
  let st = null;
  try { st = lstatSync(out); } catch (e) { if (e.code !== "ENOENT") return `${said} cannot be checked (${e.code})`; }
  if (st && !st.isFile()) return `${said} is not a regular file (a link, folder or other)`;
  const input = overlap(out, inputs);
  if (input) return `${said} is inside a reviewed input (${JSON.stringify(input)})`;
  const checkout = inCheckout(out, parent, said);
  if (checkout) return checkout;
  if (st && !ours(out)) return `${said} holds something this tool did not write (only an empty file or an earlier report is replaced)`;
  return null;
}

/** The git refusals for an --out inside the reviewed checkout, found by folder identity; null when it is outside or allowed. */
function inCheckout(out, parent, said) {
  let top;
  try { top = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } // no checkout here: nothing of it is reviewed
  const topId = identity(top);
  const names = [basename(out)];
  let rel = null;
  for (const d of ancestors(parent)) {
    if (identity(d) === topId) { rel = names.join("/"); break; }
    names.unshift(basename(d));
  }
  if (!topId || rel === null) return null;
  const git = (args) => { try { execFileSync("git", args, { cwd: top, stdio: "ignore" }); return true; } catch { return false; } };
  // icase: on a case-insensitive disk "report.json" is the tracked "Report.json" (a stricter refusal elsewhere is harmless).
  if (git(["ls-files", "--error-unmatch", "--", `:(literal,icase)${rel}`])) return `${said} is tracked in the reviewed checkout`;
  if (!git(["check-ignore", "-q", "--", rel])) return `${said} is inside the reviewed checkout and not gitignored, so it would enter the snapshot`;
  return null;
}

/** Claims --out for this run: null when claimed, else why not (the caller stops with E_USAGE). */
export function claimOut(given, inputs) {
  let parent = null;
  try { parent = realpathSync.native(dirname(resolve(given))); } catch { /* checked below */ }
  if (!parent || !statSync(parent).isDirectory()) return `--out ${JSON.stringify(given)}: its folder does not exist`;
  const out = join(parent, basename(resolve(given)));
  const why = refusal(out, parent, given, inputs);
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
