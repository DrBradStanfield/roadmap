// The --include walker and copier for tools/codex-review.mjs (US-40 AC13), in a module with no side effects, like
// codex-review-names.mjs: the wrapper and the tests import the same code, and the tests reach the race window (a folder
// or file swapped between the walk and the copy) through the injected `afterRead` callback, never a shell hook.

import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isSecretName } from "./codex-review-names.mjs";

/** A refusal or a change, carrying the path: the wrapper turns one from the walk into a usage error, one from the copy into E_INCLUDE_CHANGED. */
const fail = (path, why) => { throw Object.assign(new Error(why), { path, why }); };

/** NFKC, default-ignorable code points removed, lower case: the forms a file system or a loader could treat as the same name. */
const fold = (n) => n.normalize("NFKC").replace(/\p{Default_Ignorable_Code_Point}/gu, "").toLowerCase();
/** Codex loads AGENTS.md (and its override) from any folder it works in, so an included one could instruct it (CR3). */
export const isInstructionName = (n) => /^(?:agents(?:\.override)?\.md|claude\.md|\.codex|\.claude)$/.test(fold(n));

/** A health record by name (the roadmap file and its backups, the reviewer's scratch record) or by content under 5 MB. */
const RECORD_NAME = /^(?:health-roadmap.*\.json|scratch-record.*\.json)/i;
const SNIFF_MAX = 5 << 20;
/** The whole buffer is parsed (no prefix shortcut: leading whitespace of any length, or a BOM, must not hide a record). */
const isRecord = (bytes) => {
  if (bytes.length >= SNIFF_MAX) return false;
  try { const j = JSON.parse(bytes.toString("utf8").replace(/^﻿/, "")); return typeof j?.meta?.createdAt === "string" && (Array.isArray(j.measurements) || Array.isArray(j.labValues)); } catch { return false; }
};
const RECORD_WHY = "looks like a health record, which only --record may serve";
/** A health record by name or content: the --subject and --context files of tools/codex-review.mjs (US-40 AC15) pass the same check. */
export const isHealthRecord = (name, bytes) => RECORD_NAME.test(name) || isRecord(bytes);

/**
 * One regular file's bytes: opened without following a link or waiting on a FIFO (O_NONBLOCK), the inode's only link, at
 * most `max` bytes by fstat. Any open failure (gone, now a link, unreadable) is a change, never a scan failure.
 */
const GONE = "is gone or no longer a regular file";
export function readRegular(abs, max = Infinity) {
  let fd;
  try { fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { fail(abs, GONE); }
  try {
    const st = fstatSync(fd);
    if (!st.isFile()) fail(abs, GONE);
    if (st.nlink > 1) fail(abs, "is a hard link, whose content may live outside the folder");
    if (st.size > max) fail(abs, "grew past the --include size limit");
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

/**
 * An --include folder's regular files: { files: [[rel, abs, size]] in byte order of the UTF-8 relative path,
 * withheld: [[abs, rel]], links: rel[] }. Symlinks are stripped, never followed (CR2); `node_modules` is skipped. A
 * credential-named entry is withheld (the wrapper reads it for values). A `.git` at the top is the origin repo's own (the
 * wrapper judges it) and is not copied. Throws { path, why } for an instruction file or folder, a health record, a
 * `.git` below the top (a nested repo), a hard link, or an entry that is neither a file, a folder nor a link.
 */
export function includeWalk(root) {
  const files = [], withheld = [], links = [];
  (function walk(abs, rel) {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name), r = rel + name, st = lstatSync(p);
      if (name.toLowerCase() === ".git") { if (rel) fail(p, "is a nested git repo, whose credential values the origin scan would miss"); continue; } // at the top: the origin repo's own
      if (isInstructionName(name)) fail(p, "is an instruction file or folder the reviewer would load (AGENTS.md, CLAUDE.md, .codex/, .claude/)");
      if (RECORD_NAME.test(name)) fail(p, RECORD_WHY);
      if (isSecretName(name)) withheld.push([p, r]);
      else if (st.isSymbolicLink()) links.push(r);
      else if (st.isDirectory()) { if (name !== "node_modules") walk(p, `${r}/`); }
      else if (!st.isFile()) fail(p, "is neither a file nor a folder");
      else if (st.nlink > 1) fail(p, "is a hard link, whose content may live outside the folder");
      else if (st.size < SNIFF_MAX && isRecord(readRegular(p))) fail(p, RECORD_WHY);
      else files.push([r, p, st.size]);
    }
  })(root, "");
  files.sort((a, b) => Buffer.compare(Buffer.from(a[0]), Buffer.from(b[0])));
  return { files, withheld, links };
}

/**
 * sha256 over "<rel>\0<file sha256 hex>\n" for each file, in the walk's order; with `to`, each file is also written
 * there, read-only. Every folder from `root` down to a file must be a real folder (not a link) before the open and
 * after the read, the file must still be a regular, singly-linked file, its realpath must be the walked path, and the
 * bytes read must not be a health record (checked again here: the file may have been rewritten since the walk).
 * `budget.bytes` (optional) is what the size limit still allows: a file that grew past it throws. `afterRead(rel)` is
 * the tests' way into the race window. Residual: a folder swapped for a link and back, entirely between the two folder
 * checks, is not seen; the value and shape scan still covers the bytes copied.
 */
export function includeHash(root, files, { to = null, budget = null, afterRead = null } = {}) {
  const h = createHash("sha256");
  let bytes = 0;
  const realFolders = (rel) => {
    let d = root;
    for (const c of ["", ...rel.split("/").slice(0, -1)]) {
      d = c ? join(d, c) : d;
      let st; try { st = lstatSync(d); } catch { fail(d, "is gone"); }
      if (!st.isDirectory() || st.isSymbolicLink()) fail(d, "is no longer a real folder");
    }
  };
  for (const [rel, abs] of files) {
    realFolders(rel);
    const b = readRegular(abs, budget?.bytes);
    afterRead?.(rel);
    realFolders(rel);
    let rp = null; try { rp = realpathSync(abs); } catch { /* gone: fails below */ }
    if (rp !== abs) fail(abs, "resolves somewhere else");
    if (budget && (budget.bytes -= b.length) < 0) fail(abs, "grew past the --include size limit");
    if (isRecord(b)) fail(abs, RECORD_WHY); // the exact bytes about to be copied: the walk's check may be stale
    if (to) { mkdirSync(dirname(join(to, rel)), { recursive: true }); writeFileSync(join(to, rel), b, { flag: "wx", mode: 0o444 }); }
    h.update(`${rel}\0${createHash("sha256").update(b).digest("hex")}\n`);
    bytes += b.length;
  }
  return { sha256: h.digest("hex"), bytes };
}
