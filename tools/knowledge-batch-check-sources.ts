/** Sources split out of knowledge-batch-check.ts (file-size ratchet, US-64 AC23): the raw files a report names
 *  (US-42 AC2, US-50 AC1) and the reference checks and identifiers (US-42 AC7, US-70 AC2). */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseFrontmatter } from "../app/lib/frontmatter";
import { REF_LINE, classifyLines, normChars } from "./knowledge-tokenise";
import { BANNED, BRAND_RANKING, TESTER, clip, normQuote, productMentions, sha256 } from "./knowledge-batch-check-text";
import type { Ctx, Options, Report } from "./knowledge-batch-check-report";
import { Check, gitShow } from "./knowledge-batch-check-report";

function rootRegexes(roots: string[]): RegExp[] {
  return roots.map((r) => {
    const p = r.startsWith("~/") ? join(homedir(), r.slice(2)) : r;
    const segs = p.replace(/\/+$/, "").split("/");
    const star = segs.findIndex((x) => x.includes("*"));
    const prefix = segs.slice(0, star < 0 ? segs.length : star).join("/") || "/";
    let real = prefix;
    try { real = realpathSync(prefix); } catch { /* a missing root matches nothing real */ }
    const full = [real === "/" ? "" : real, ...(star < 0 ? [] : segs.slice(star))].join("/");
    return new RegExp(`^${full.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}/`);
  });
}

function defaultRawRoots(): string[] {
  const j = JSON.parse(readFileSync(new URL("./codex-review-includes.json", import.meta.url), "utf8")) as { roots: string[] };
  return j.roots.filter((r) => r.includes("knowledge-map-raw"));
}

export interface RawSet {
  main: { norm: string; rel: string; pmid: string | null } | null; extras: { path: string; norm: string; pmid: string | null; repoRel?: string }[];
  /** Files under a pubmed/ folder headed "# PubMed <pmid>": the only raw that verifies a primary reference. */
  abstracts: { pmid: string; norm: string }[];
}

/** Open a report's raw files: each must resolve (realpath) under an allowed raw root, never inside the repo, with the sha256 the report gives. */
/** Brad's own posts and the files that carry his positions (US-50 AC1): raw for a master, read from the base revision. */
export const MASTER_RAW = /(?:^|\/)(docs\/blog\/[^/]+\.md|docs\/products\.md|docs\/guideline\/[^/]+\.md|app\/lib\/chat-system-prompt\.md|packages\/health-core\/src\/evidence(?:-screening)?\.ts|health_roadmap_algorithm\.md|roadmap_text\.html)$/;

export function loadRaw(rep: Report, o: Options, tag: string, ac2: Check, isPost: (h: string) => boolean): RawSet {
  const roots = rootRegexes(o.rawRoots ?? defaultRawRoots());
  const repoReal = realpathSync(o.root);
  // Several extra_raw entries may name one path (a correction appends the new sha): ANY match accepts it, the rest are INFO.
  const superseded = (hash: string, shas: string[], label: string) => {
    for (const s of shas) if (s !== hash) ac2.infos.push(`${tag} ${label}: superseded sha ${s}`);
  };
  const open = (path: string, shas: string[], label: string) => {
    if (!existsSync(path)) { ac2.fails.push(`${tag} ${label} file not found: ${path}`); return null; }
    const real = realpathSync(path);
    if (real === repoReal || real.startsWith(`${repoReal}/`)) { ac2.fails.push(`${tag} ${label} is inside the repo: ${path}`); return null; }
    const hit = roots.map((r) => r.exec(real)).find((m) => m);
    if (!hit) { ac2.fails.push(`${tag} ${label} is outside the allowed raw roots: ${path}`); return null; }
    const buf = readFileSync(real);
    const hash = sha256(buf);
    if (!shas.includes(hash)) { ac2.fails.push(`${tag} ${label} sha256 mismatch for ${path} (file ${hash}, report ${shas.join(", ")})`); return null; }
    superseded(hash, shas, `${label} ${path}`);
    const text = buf.toString("utf8");
    const pmid = /\/pubmed\//.test(real) ? /^\s*#\s*PubMed\s+(\d+)/i.exec(text)?.[1] ?? null : null;
    return { norm: normQuote(text), rel: real.slice(hit[0].replace(/[^/]+\/$/, "").length), pmid };
  };
  const main = open(rep.raw_path, [rep.raw_sha256], "raw");
  const extras: RawSet["extras"] = [];
  const abstracts: { pmid: string; norm: string }[] = [];
  if (main?.pmid) abstracts.push({ pmid: main.pmid, norm: main.norm });
  const byPath = new Map<string, string[]>();
  for (const x of rep.extra_raw ?? []) if (!x.void) byPath.set(x.path, [...(byPath.get(x.path) ?? []), x.sha256]);
  for (const [path, shas] of byPath) {
    const repoRel = o.masters && !path.split("/").includes("..") ? MASTER_RAW.exec(path)?.[1] : undefined;
    if (repoRel) {
      // A post is raw only when it is one of Brad's video posts outside this batch: never a reference, never a page the batch rewrites.
      const post = /^docs\/blog\/(.+)\.md$/.exec(repoRel)?.[1];
      if (post !== undefined && (!isPost(post) || o.handles.includes(post))) { ac2.fails.push(`${tag} extra_raw ${repoRel} is not a video post outside this batch`); continue; }
      const text = gitShow(o.root, o.base, repoRel), hash = text === null ? "" : sha256(text);
      if (text === null) ac2.fails.push(`${tag} extra_raw ${repoRel} does not exist at ${o.base}`);
      else if (!shas.includes(hash)) ac2.fails.push(`${tag} extra_raw sha256 mismatch for ${repoRel} at ${o.base} (file ${hash}, report ${shas.join(", ")})`);
      else { superseded(hash, shas, `extra_raw ${repoRel}`); extras.push({ path, norm: normQuote(text), pmid: null, repoRel }); }
      continue;
    }
    const e = open(path, shas, "extra_raw");
    if (!e) continue;
    extras.push({ path, norm: e.norm, pmid: e.pmid });
    if (e.pmid) abstracts.push({ pmid: e.pmid, norm: e.norm });
  }
  return { main, extras, abstracts };
}

function referenceCheck(body: string, tag: string, ac7: Check) {
  const cl = classifyLines(body);
  const defs = new Set<number>(), cited = new Set<number>();
  for (const { line, ref } of cl) {
    const m = line.match(REF_LINE) ?? (ref ? line.match(/^\s*(?:[-*]\s*)?(\d+)[.)]\s+\S/) : null);
    if (m) defs.add(Number(m[1]));
  }
  for (const { line, ref } of cl) {
    if (ref) continue;
    for (const m of line.matchAll(/\[(\d+(?:\s*[,–-]\s*\d+)*)\](?!\()/g)) {
      for (const part of m[1].split(",")) {
        const r = part.split(/[–-]/).map((x) => Number(x.trim()));
        for (let n = r[0]; n <= (r[1] ?? r[0]); n++) cited.add(n);
      }
    }
  }
  const missing = [...cited].filter((n) => !defs.has(n)), uncited = [...defs].filter((n) => !cited.has(n));
  if (missing.length) ac7.fails.push(`${tag} citations with no reference line: ${missing.join(", ")}`);
  if (uncited.length) ac7.fails.push(`${tag} reference lines never cited: ${uncited.join(", ")}`);
  ac7.infos.push(`${tag} ${defs.size} references, ${cited.size} cited`);
}

const ALLOWED_HOSTS = ["ods.od.nih.gov", "pubmed.ncbi.nlm.nih.gov", "doi.org", "dailymed.nlm.nih.gov", "accessdata.fda.gov", "medlineplus.gov"];
/** A condition guide's reference hosts (US-70 AC2): public records, plus the guideline and label sites its own `sources:` names. */
export function guideHosts(text: string): string[] {
  const sources: unknown = parseFrontmatter(text)?.sources;
  const named = Array.isArray(sources) ? sources.map((x: { url?: unknown }) => hostOf(String(x?.url ?? ""))).filter((h) => h && !new RegExp(`(^|\\.)${TESTER.toLowerCase()}\\.com$`).test(h)) : [];
  return ["ods.od.nih.gov", "pubmed.ncbi.nlm.nih.gov", "doi.org", "dailymed.nlm.nih.gov", "accessdata.fda.gov", ...named];
}
const URL_RE = /https?:\/\/[^\s)\]>]+/g;
const hostOf = (u: string) => { try { return new URL(u.replace(/[.,;]+$/, "")).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; } };

export function refLines(body: string): string[] {
  return classifyLines(body).filter(({ line, ref }) => ref && (REF_LINE.test(line) || /^\s*(?:[-*]\s*)?\d+[.)]\s+\S/.test(line))).map((x) => x.line);
}

/** A drstanfield.com link to a video post (its handle) or the roadmap page ("" ), else null. */
export const bradLink = (u: string) => /^https?:\/\/(?:www\.)?drstanfield\.com\/(?:blogs\/articles\/([a-z0-9-]+)|pages\/roadmap)\/?(?:[?#][^\s)]*)?$/i.exec(u.replace(/[.,;]+$/, ""));

function referenceSourceCheck(newBody: string, baseBody: string, tag: string, ac7: Check, isPost?: (h: string) => boolean, hosts = ALLOWED_HOSTS) {
  const known = new Set(refLines(baseBody).flatMap((l) => (l.match(URL_RE) ?? []).map(hostOf)));
  for (const line of refLines(newBody)) {
    const urls = line.match(URL_RE) ?? [];
    const title = line.replace(/\[([^\]]*)\]\([^)]*\)/g, (_, t: string) => (/^https?:/i.test(t) ? "" : t)).replace(URL_RE, "").replace(/^\s*(?:[-*]\s*)?(?:\[\d+\]|\d+[.)])/, "");
    if (urls.length && !/[A-Za-z]{2}/.test(title)) ac7.fails.push(`${tag} reference line is a bare URL without a title: ${clip(line, 100)}`);
    for (const u of urls) {
      const h = hostOf(u);
      if (!h) { ac7.fails.push(`${tag} reference line has an unparseable URL ${clip(u, 60)}: ${clip(line, 100)}`); continue; }
      if (hosts.some((a) => h === a || h.endsWith(`.${a}`)) || known.has(h)) continue;
      const brad = isPost && bradLink(u);
      if (brad && (brad[1] === undefined || isPost!(brad[1].toLowerCase()))) continue; // Brad's video posts and the roadmap page (US-50)
      ac7.fails.push(`${tag} reference line has unknown host ${h}: ${clip(line, 100)}`);
    }
  }
}

/** A renumbering script can change the visible id and leave the URL right: link text and printed ids must match their URLs. */
function linkTextCheck(body: string, tag: string, ac7: Check) {
  const trim = (d: string) => d.replace(/[.,;:]+$/, "").toLowerCase();
  for (const line of refLines(body)) {
    const pmidUrls = [...line.matchAll(/pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/gi)].map((m) => m[1]);
    for (const m of line.matchAll(/\[([^\]]*)\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))+)\)/g)) {
      const [, text, url] = m;
      const pm = /pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/i.exec(url);
      if (pm) for (const t of text.match(/\b\d{5,9}\b/g) ?? []) if (t !== pm[1]) ac7.fails.push(`${tag} reference line: PMID link text ${t} differs from its URL id ${pm[1]}: ${clip(line, 100)}`);
      const dm = /doi\.org\/(10\.\d{4,9}\/.+)$/i.exec(url);
      const dt = /\b(10\.\d{4,9}\/[^\s\]]+)/.exec(text);
      if (dm && dt && trim(dt[1]) !== trim(dm[1])) ac7.fails.push(`${tag} reference line: DOI link text ${trim(dt[1])} differs from its URL DOI ${trim(dm[1])}: ${clip(line, 100)}`);
    }
    if (pmidUrls.length) for (const m of line.matchAll(/PMID:?\s*(\d{5,9})/gi)) {
      if (!pmidUrls.includes(m[1])) ac7.fails.push(`${tag} reference line: PMID ${m[1]} differs from the pubmed URL id ${pmidUrls.join(", ")}: ${clip(line, 100)}`);
    }
  }
}

const PRODUCT_HEADING = /product|microvitamin|sleep by dr brad/i;
function sectionsMatching(body: string): Map<string, string> {
  const lines = body.split(/(?<=\n)/), out = new Map<string, string>();
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s/);
    if (!m || !PRODUCT_HEADING.test(lines[i])) continue;
    let j = i + 1;
    while (j < lines.length && !(/^#{1,6}\s/.test(lines[j]) && lines[j].match(/^(#+)/)![1].length <= m[1].length)) j++;
    out.set(lines[i].trim(), lines.slice(i, j).join(""));
  }
  return out;
}

function productSectionCheck(newBody: string, baseBody: string, tag: string, ac7: Check) {
  const a = sectionsMatching(baseBody), b = sectionsMatching(newBody);
  for (const [h, text] of a) {
    if (!b.has(h)) ac7.fails.push(`${tag} product section missing: ${h}`);
    else if (b.get(h) !== text) ac7.fails.push(`${tag} product section changed: ${h}`);
  }
  for (const h of b.keys()) if (!a.has(h)) ac7.fails.push(`${tag} product section added: ${h}`);
}

export interface PrimaryId { kind: "pmid" | "doi"; id: string }
export function primaryIds(line: string): PrimaryId[] {
  const out = new Map<string, PrimaryId>();
  for (const m of line.matchAll(/PMID:?\s*(\d{5,9})|pubmed\.ncbi\.nlm\.nih\.gov\/(\d{5,9})/gi)) out.set(`pmid:${m[1] ?? m[2]}`, { kind: "pmid", id: (m[1] ?? m[2]) });
  for (const m of line.matchAll(/\b(10\.\d{4,9}\/(?:[^\s()\]>,;"]|\([^\s()]*\))+)/g)) {
    const id = m[1].replace(/[.,;:]+$/, "");
    out.set(`doi:${id.toLowerCase()}`, { kind: "doi", id });
  }
  return [...out.values()];
}

/** `hosts`, set only for a condition guide (US-70), runs the reference checks on the guide with those source hosts. */
export function checkAc7(c: Ctx, ac7: Check, abstracts: RawSet["abstracts"], idsOut: Map<string, PrimaryId & { handle: string }>, isPost?: (h: string) => boolean, hosts?: string[]) {
  const tag = `${c.handle}:`, rep = c.rep;
  const lines = normChars(c.newBody).split(/\r?\n/);
  for (const l of lines) {
    if (/grokipedia/i.test(l)) ac7.fails.push(`${tag} "grokipedia" in body: ${clip(l, 100)}`);
    for (const b of BANNED) if (l.toLowerCase().includes(b.toLowerCase())) ac7.fails.push(`${tag} banned phrase "${b}": ${clip(l, 100)}`);
    if (BRAND_RANKING.test(l)) ac7.fails.push(`${tag} brand ranking phrase: ${clip(l, 100)}`);
  }
  const pb = productMentions(c.baseBody), pa = productMentions(c.newBody);
  if (pa > pb) ac7.fails.push(`${tag} product mentions rose ${pb} -> ${pa}`);
  if (rep && (rep.product_mentions_before !== pb || rep.product_mentions_after !== pa)) {
    // No rise is the invariant; a report that counted differently but saw no change either way is a note.
    const flat = pb === pa && rep.product_mentions_before === rep.product_mentions_after;
    (flat ? ac7.warns : ac7.fails).push(`${tag} ${flat ? "count differs from report: " : ""}report says product mentions ${rep.product_mentions_before} -> ${rep.product_mentions_after}, recomputed ${pb} -> ${pa}`);
  }
  if (c.type === "reference" || (hosts && c.type === "guideline")) {
    referenceCheck(c.newBody, tag, ac7);
    referenceSourceCheck(c.newBody, c.baseBody, tag, ac7, isPost, hosts);
    linkTextCheck(c.newBody, tag, ac7);
    productSectionCheck(c.newBody, c.baseBody, tag, ac7);
    // "New" ignores the leading number, so a renumbered reference is not new.
    const unnumbered = (l: string) => l.replace(/^\s*(?:[-*]\s*)?(?:\[\d+\]|\d+[.)])\s*/, "").trim();
    const baseLines = new Set(refLines(c.baseBody).map(unnumbered));
    // Under --masters or --guides (isPost is passed only then), --check-ids resolves every identifier, retained ones too.
    if (isPost) for (const line of refLines(c.newBody)) for (const x of primaryIds(line)) idsOut.set(`${x.kind}:${x.id.toLowerCase()}`, { ...x, handle: c.handle });
    for (const line of refLines(c.newBody).filter((l) => !baseLines.has(unnumbered(l)))) {
      const ids = primaryIds(line);
      for (const x of ids) idsOut.set(`${x.kind}:${x.id.toLowerCase()}`, { ...x, handle: c.handle });
      const verified = (x: PrimaryId) => (x.kind === "pmid" ? abstracts.some((a) => a.pmid === x.id) : abstracts.some((a) => a.norm.includes(x.id.toLowerCase())));
      if (/pubmed\.ncbi\.nlm\.nih\.gov|PMID/i.test(line)) {
        // A new PubMed record must arrive with its abstract file: extra_raw, on disk, sha-checked, headed "# PubMed <pmid>".
        const pm = ids.filter((x) => x.kind === "pmid");
        if (!pm.length || pm.some((x) => !verified(x))) ac7.fails.push(`${tag} new PubMed reference has no abstract file in extra_raw: ${clip(line, 120)}`);
      } else if (ids.some((x) => !verified(x))) ac7.warns.push(`${tag} unverified primary: ${clip(line, 140)}`);
    }
  }
}

function curlHead(url: string): number {
  try {
    return parseInt(execFileSync("curl", ["-sS", "-I", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "15", url], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }), 10) || 0;
  } catch { return 0; }
}
const sleepMs = (ms: number) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

/** One HEAD request a second; the cap is --check-ids-cap, default unlimited under --masters and 60 otherwise. */
export function verifyIds(ids: Map<string, PrimaryId & { handle: string }>, o: Options, ac7: Check) {
  const head = o.headStatus ?? curlHead;
  const list = [...ids.values()], cap = o.idCap ?? (o.masters ? Infinity : 60);
  list.slice(0, cap).forEach((x, i) => {
    if (i) sleepMs(o.delayMs ?? 1000);
    const url = x.kind === "doi" ? `https://doi.org/${x.id}` : `https://pubmed.ncbi.nlm.nih.gov/${x.id}/`;
    const st = head(url);
    if (st === 404) ac7.fails.push(`${x.handle}: ${x.kind} ${x.id} returned 404`);
    else if (st === 0 || st >= 400) ac7.warns.push(`${x.handle}: ${x.kind} ${x.id} returned ${st || "no response"} (not verified)`);
  });
  if (list.length > cap) ac7.warns.push(`${list.length - cap} identifiers not checked (cap ${cap})`);
}

