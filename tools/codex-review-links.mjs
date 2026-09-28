// Allowlisted symlinks the codex-review snapshot MATERIALISES as regular files
// instead of dropping (US-40 AC12, 2026-09-29). Every other symlink is still
// removed (AC1).
//
// Why: claude_business keeps its product master as a symlink into the roadmap
// repo (docs/products.md), so a symlink-free snapshot had no product facts and
// every supplement-copy claim check came back unverifiable.
//
// Each entry pins BOTH ends: the link's path in the reviewed repo and the exact
// target (repo name + repo-relative path). A link is materialised only when:
//   * the reviewed checkout is the entry's `reviewed` repo (realpath match);
//   * the link's text, resolved from its own directory, is EXACTLY the pinned
//     target (a retargeted link is refused);
//   * no component of the link path, the link text or the pinned path is
//     credential-named (codex-review-names.mjs) or `.git`;
//   * target in the reviewed repo itself: copied from the SNAPSHOT's own regular
//     file at the pinned path (the revision under review), reached through no
//     symlink;
//   * target in another repo: the COMMITTED blob at that repo's HEAD, read by
//     sha with git (`--literal-pathspecs`, mode 100644 only); never the working
//     tree, so an uncommitted or untracked file can never be sent;
//   * the content is at most MAX_LINK_BYTES.
// The wrapper also collects every external source repo's credential values
// before its scans (externalSources), so a copied file is value-checked against
// the repo it came from, then scans it like every other file.

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readlinkSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isSecretPath } from "./codex-review-names.mjs";

export const MAX_LINK_BYTES = 1 << 20;

/** repos: name → checkout path. links: { reviewed, link, target, path } (target = a repo name; path = repo-relative). */
export const LINK_POLICY = {
  repos: {
    roadmap: resolve(dirname(fileURLToPath(import.meta.url)), ".."), // the wrapper's own checkout
    claude_business: join(homedir(), "Library", "CloudStorage", "Dropbox", "YouTube", "multivitamin & others", "claude_business"),
  },
  links: [
    { reviewed: "claude_business", link: "docs/products.md", target: "roadmap", path: "docs/products.md" }, // the product master
    { reviewed: "claude_business", link: "docs/products-overages.md", target: "claude_business", path: "memory/products-overages.md" }, // the repo's own tracked backup, not ~/.claude
  ],
};

const realOr = (p) => { try { return realpathSync(p); } catch { return null; } };
const bad = (p) => isSecretPath(p) || p.split(/[\\/]/).includes(".git");
const git = (repo, args, o = {}) => execFileSync("git", ["--literal-pathspecs", "-C", repo, ...args], { stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20, ...o });

/** The policy's name for the reviewed checkout, or null. */
function reviewedName(root, policy) {
  const r = realOr(root);
  return r ? Object.keys(policy.repos).find((n) => realOr(policy.repos[n]) === r) ?? null : null;
}

/** A repo path that is the top level of its own git repository (not a folder inside another), or null. */
function repoTop(path) {
  const r = realOr(path);
  if (!r) return null;
  try { return realOr(git(r, ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim()) === r ? r : null; } catch { return null; }
}

/** Other repos this checkout's entries copy from: [{ name, path }]. The wrapper collects their credential values. */
export function externalSources(root, policy = LINK_POLICY) {
  const self = reviewedName(root, policy);
  if (!self) return [];
  const names = [...new Set(policy.links.filter((l) => l.reviewed === self && l.target !== self).map((l) => l.target))];
  return names.flatMap((name) => { const path = repoTop(policy.repos[name] ?? ""); return path ? [{ name, path }] : []; });
}

/** { commit, blob } for `path` at the repo's HEAD, only when it is a regular (100644) blob; else { why }. */
export function headBlob(repo, path) {
  let commit, entry;
  try {
    commit = git(repo, ["rev-parse", "--verify", "HEAD^{commit}"], { encoding: "utf8" }).trim();
    entry = git(repo, ["ls-tree", "-z", "--full-tree", commit, "--", path], { encoding: "utf8" });
  } catch { return { why: "the target repo's HEAD could not be read" }; }
  const rows = entry.split("\0").filter(Boolean);
  const t = rows.length === 1 ? rows[0].indexOf("\t") : -1;
  if (t < 0 || rows[0].slice(t + 1) !== path) return { why: "the pinned target is not committed at the target repo's HEAD" };
  const [mode, type, blob] = rows[0].slice(0, t).split(" ");
  if (type !== "blob" || mode !== "100644") return { why: `the pinned target is not a regular file (mode ${mode})` };
  return { commit, blob };
}

/** Reads at most max+1 bytes through one descriptor; null when not a regular file or over the cap. */
function readCapped(p, max) {
  const fd = openSync(p, "r");
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(max + 1);
    let n = 0, r;
    while (n <= max && (r = readSync(fd, buf, n, max + 1 - n, null)) > 0) n += r;
    return n > max ? null : buf.subarray(0, n);
  } finally { closeSync(fd); }
}

const sha256 = (b) => createHash("sha256").update(b).digest("hex");

/**
 * Decides, for each symlink in `links` (paths relative to `src`), whether it is
 * materialised. Reads only; changes nothing. Returns { ok: [{ rel, bytes,
 * provenance }], refused: [{ rel, reason }] }; a link with no entry is in
 * neither list (it is simply dropped).
 */
export function resolveAllowedLinks({ src, root, links, policy = LINK_POLICY, maxBytes = MAX_LINK_BYTES }) {
  const ok = [], refused = [];
  const self = reviewedName(root, policy);
  if (!self) return { ok, refused };
  const realRoot = realOr(root), realSrc = realOr(src);
  const linkSet = new Set(links);
  for (const rel of links) {
    const entry = policy.links.find((l) => l.reviewed === self && l.link === rel);
    if (!entry) continue;
    const no = (reason) => refused.push({ rel, reason });
    if (bad(rel) || bad(entry.path)) { no("the link path or the pinned target is credential-named or inside .git"); continue; }
    let text;
    try { text = readlinkSync(join(src, rel)); } catch { no("unreadable link"); continue; }
    if (bad(text)) { no("the link target is credential-named or inside .git"); continue; }
    const targetRoot = policy.repos[entry.target];
    if (!targetRoot) { no("the pinned target repo is not in the policy"); continue; }
    const pinned = new Set([join(targetRoot, entry.path), join(realOr(targetRoot) ?? targetRoot, entry.path)]);
    const means = isAbsolute(text) ? [resolve(text)] : [resolve(root, dirname(rel), text), resolve(realRoot, dirname(rel), text)];
    if (!means.some((m) => pinned.has(m))) { no("the link does not point at its pinned target"); continue; }
    if (entry.target === self) {
      // The reviewed repo itself: the snapshot's own copy, a regular file reached through no link.
      const p = join(src, entry.path);
      if (linkSet.has(entry.path) || realOr(p) !== join(realSrc, entry.path)) { no("the target in the snapshot is absent, or is (or passes through) a symlink"); continue; }
      if (!lstatSync(p).isFile()) { no("the target in the snapshot is not a regular file"); continue; }
      const bytes = readCapped(p, maxBytes);
      if (!bytes) { no(`the target is over ${maxBytes} bytes`); continue; }
      ok.push({ rel, bytes, provenance: { link: rel, source: "snapshot", path: entry.path, sha256: sha256(bytes) } });
      continue;
    }
    // Another repo: its committed blob at HEAD, never the working tree.
    const repo = repoTop(targetRoot);
    if (!repo) { no("the target repo is not a git checkout"); continue; }
    const hb = headBlob(repo, entry.path);
    if (hb.why) { no(hb.why); continue; }
    const size = Number(git(repo, ["cat-file", "-s", hb.blob], { encoding: "utf8" }).trim());
    if (!(size <= maxBytes)) { no(`the target is over ${maxBytes} bytes`); continue; }
    const bytes = git(repo, ["cat-file", "blob", hb.blob]);
    if (bytes.length !== size) throw new Error("short blob read");
    ok.push({ rel, bytes, provenance: { link: rel, source: entry.target, path: entry.path, commit: hb.commit, blob: hb.blob, sha256: sha256(bytes) } });
  }
  return { ok, refused };
}

/**
 * Removes every symlink in `links` from `src`, then writes each allowlisted one
 * back as a regular file (decided BEFORE any unlink). A throw is the caller's
 * to turn into an incomplete review.
 * Returns { removed: rel[], materialised: provenance[], refused: [{ rel, reason }] }.
 */
export function materialiseLinks({ src, root, links, policy, maxBytes }) {
  const { ok, refused } = resolveAllowedLinks({ src, root, links, policy, maxBytes });
  for (const rel of links) unlinkSync(join(src, rel));
  for (const { rel, bytes } of ok) writeFileSync(join(src, rel), bytes, { flag: "wx" });
  const done = new Set(ok.map((e) => e.rel));
  return { removed: links.filter((l) => !done.has(l)), materialised: ok.map((e) => e.provenance), refused };
}
