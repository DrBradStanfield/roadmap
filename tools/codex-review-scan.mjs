import { closeSync, existsSync, fstatSync, openSync, readdirSync, readSync, rmSync } from "node:fs";
import { join } from "node:path";
import { isSecretPath } from "./codex-review-names.mjs";
import { PATTERN_SPAN, PATTERNS } from "./secret-rules.mjs";
/**
 * Secret-named key: any `_`-delimited word (camelCase split too) is one of
 * these, or its plural. Such a key's values count from 8 characters (matched
 * as a whole word); every other value from 16. AUTH is a word, so OAUTH and
 * AUTHOR are not.
 */
const SECRET_WORDS = ["KEY", "APIKEY", "ACCESSKEY", "PRIVATEKEY", "TOKEN", "SECRET", "PASSWORD", "PASS", "PASSWD", "PASSPHRASE", "PWD", "PW", "PRIVATE", "CREDENTIAL", "AUTH", "DSN", "SALT", "SIGNING", "SIGNATURE", "COOKIE", "SESSION", "BEARER", "CERT", "API", "WEBHOOK", "HOOK", "REFRESH", "SK", "READ"];
const isSecretKey = (k) => k.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase().split(/[_.-]+/).some((w) => SECRET_WORDS.includes(w) || (w.endsWith("S") && SECRET_WORDS.includes(w.slice(0, -1))));
/** Secret words run together with others (GOOGLEAPIKEY_ID): such a key is never a public identifier either. */
const JOINED_SECRET = /PRIVATEKEY|ACCESSKEY|APIKEY|SECRET|TOKEN|PASSW|REFRESH|SIGNATURE|CREDENTIAL/;
const MIN_VALUE = 16, MIN_SECRET_KEY_VALUE = 8;
/** A run of 16+ letters and digits holding both, the shape of a token. */
const tokenRun = (s) => (s.match(/[A-Za-z0-9]{16,}/g) ?? []).some((r) => /\d/.test(r) && /[A-Za-z]/.test(r));
/** 20+ characters, or 9+ mixing letters and digits: a URL's host label or path word shaped like a token. */
const tokenish = (w) => w.length >= 20 || (w.length > 8 && /\d/.test(w) && /[A-Za-z]/.test(w));
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
/** A bare hostname (a Shopify handle such as `ab12cd-3e.myshopify.com` included). */
const isHost = (h) => h.includes(".") && h.split(".").every((l) => LABEL.test(l));
/** scheme://host[:port] and at most four plain words of path: no userinfo, query or fragment, and no token-shaped host label or word. */
const isUrl = (s) => {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#@:]+)(?::\d{1,5})?((?:\/[A-Za-z][A-Za-z_-]*){0,4})\/?$/i.exec(s);
  return !!m && m[1].split(".").every((l) => LABEL.test(l) && !tokenish(l)) && !m[2].split("/").some(tokenish);
};
/** Short words (a region, a project, a scope list); a word holding `/` must be a URL, so a scheme-less path-like value fails. */
const isShort = (s) => /^[\w.,:/ -]{1,200}$/.test(s) && !tokenRun(s) && s.split(/[\s,]+/).every((w) => !w.includes("/") || isUrl(w));
/**
 * The ONLY values that may already sit in an ordinary file at base: a
 * public-identifier key (after one market suffix, `_ID_AU`) whose value has
 * that identifier's shape. A secret-named key (AWS_ACCESS_KEY_ID) never
 * qualifies, and neither does any value of the wrong shape. Keys are
 * matched in upper case only, as .env files write them.
 */
const PUBLIC_SHAPES = [
  [/(?:^|_)(?:SHOP|DOMAIN|STORE)$/, (s) => isHost(s)],
  [/(?:^|_)EMAIL$/, (s) => /^[\w.+-]{1,64}@[^@]+$/.test(s) && isHost(s.split("@")[1])],
  [/(?:^|_)ID$/, (s) => /^(?:\d+|act_\d+|[0-9a-f]{1,40}|\d+-[a-z0-9]+\.apps\.googleusercontent\.com)$/i.test(s)],
  [/(?:^|_)(?:URL|ISSUER)$/, isUrl],
  [/(?:^|_)(?:REGION|PROJECT|SCOPES|USERNAME)$/, isShort],
  [/(?:^|_)PATH$/, (s) => isPathValue(s)],
];
/**
 * Inside a COPY from another repo (US-40 AC12) the exemption is stricter: no host label, email local part or short
 * word may be token-shaped, and an `_ID` is digits, `act_` digits or a Google client ID only (no bare hex).
 */
const notTokenish = (w) => !tokenish(w) && !tokenRun(w);
const COPY_SHAPES = [
  [/(?:^|_)(?:SHOP|DOMAIN|STORE)$/, (s) => isHost(s) && s.split(".").every(notTokenish)],
  [/(?:^|_)EMAIL$/, (s) => { const [local, host, extra] = s.split("@"); return extra === undefined && /^[\w.+-]{1,64}$/.test(local ?? "") && notTokenish(local) && isHost(host ?? "") && host.split(".").every(notTokenish); }],
  [/(?:^|_)ID$/, (s) => /^(?:\d+|act_\d+|\d+-[a-z0-9]+\.apps\.googleusercontent\.com)$/i.test(s)],
  [/(?:^|_)(?:URL|ISSUER)$/, isUrl],
  [/(?:^|_)(?:REGION|PROJECT|SCOPES|USERNAME)$/, (s) => isShort(s) && s.split(/[\s,]+/).every((w) => w.includes("/") || notTokenish(w))],
  [/(?:^|_)PATH$/, (s) => isPathValue(s)],
];
const isPublic = (key, s, shapes = PUBLIC_SHAPES) => {
  if (isSecretKey(key) || JOINED_SECRET.test(key.toUpperCase())) return false;
  const k = key.replace(/_(?:AU|UK|US|CA|EU|NZ|DE|GB)$/, "");
  const shape = shapes.find(([re]) => re.test(k));
  return !!shape && shape[1](s);
};
/** PEM armour and filesystem paths are not credential values (a code file quoting "-----BEGIN PRIVATE KEY-----" must not brick every review); a path under a secret-named key is. */
const PEM_ARMOUR = /^-----(?:BEGIN|END)[ A-Z0-9]*-----$/;
const isPathValue = (s) => /^(?:~[\w.-]*)?\/[^\s+=]*$/.test(s) && !tokenRun(s);
/**
 * --loop (US-40 AC10): a loop's credentials live in its environment, so those values count too. The listed system
 * variables, paths that exist, and a value inside the temp or repo path do not: the prompt must carry those paths (a
 * session id in the scratch path). A secret-named key never gets the path exemption.
 */
const SYSTEM_ENV = /^(?:PATH|HOME|PWD|SHELL|TMPDIR|LANG|TERM|USER|NODE_ENV|NODE_OPTIONS|NODE_PATH|npm_lifecycle_.*|npm_package_.*|npm_node_execpath|npm_execpath|npm_command)$/;
/** An environment path may hold spaces (OLDPWD) or be a `:` list (MANPATH): every part is an absolute or `~/` path that exists, and no token run. */
const isEnvPath = (v) => v.split(":").every((p) => /^~?\//.test(p) && existsSync(p.replace(/^~/, process.env.HOME ?? "\0"))) && !tokenRun(v);
/** A pattern hit is recorded as NUL + its name, which no value read from a text line carries. */
const PATTERN_HIT = "\0";
/**
 * Substring search over bytes for the values (and, with `patterns`, the
 * PATTERNS), streamed in 1 MB chunks with a carry, so a match across a seam
 * is still found. Values under 16 characters match only as a whole word (no
 * letter or digit either side).
 */
const SKIP_BINARY_OVER = 4 << 20;
function searcher(values, patterns) {
  const list = [...values.keys()].sort((a, b) => b.length - a.length);
  const esc = (v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alts = list.map((v) => (values.get(v).short ? `(?<![A-Za-z0-9])${esc(v)}(?![A-Za-z0-9])` : esc(v)));
  if (patterns) alts.push(...Object.entries(PATTERNS).map(([name, re]) => `(?<${name}>${re})`));
  if (!alts.length) return null;
  const re = new RegExp(alts.join("|"), "g");
  const carryLen = Math.max(list[0]?.length ?? 0, patterns ? PATTERN_SPAN : 0) + 1; // the longest match plus one character of context before it
  const hit = (m) => { const name = m.groups && Object.keys(m.groups).find((n) => m.groups[n] !== undefined); return name ? PATTERN_HIT + name : m[0]; };
  /** mode "all": every match; "inner": only matches with a character after them (more may follow); "tail": only matches ending at the end. */
  const scan = (s, found, mode = "all") => {
    for (const m of s.matchAll(re)) { const atEnd = m.index + m[0].length === s.length; if (mode === "all" || (mode === "tail") === atEnd) found.add(hit(m)); }
    return found;
  };
  const buf = Buffer.alloc(1 << 20);
  /** The hits in one file, or null when it is a binary over SKIP_BINARY_OVER. */
  const inFile = (p) => {
    const fd = openSync(p, "r"), found = new Set();
    try {
      const big = fstatSync(fd).size > SKIP_BINARY_OVER;
      let carry = "", n, first = true;
      while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) {
        if (first && big && buf.subarray(0, Math.min(n, 8192)).includes(0)) return null;
        first = false;
        const s = carry + buf.toString("latin1", 0, n);
        scan(s, found, "inner");
        carry = s.slice(-carryLen);
      }
      scan(carry, found, "tail");
    } finally { closeSync(fd); }
    return found;
  };
  /** { hits: rel path → hits, skipped: rel paths of binaries too big to search }, for every regular file under dir. */
  const inDir = (dir, prefix = "") => {
    const hits = new Map(), skipped = [];
    (function walk(d) {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) {
          const rel = prefix + p.slice(dir.length + 1);
          const found = inFile(p);
          if (found === null) skipped.push(rel);
          else if (found.size) hits.set(rel, found);
        }
      }
    })(dir);
    return { hits, skipped };
  };
  return { inText: (s) => scan(Buffer.from(s, "utf8").toString("latin1"), new Set()), inDir, inFile };
}
/** Every path under dir (files, directories, links) whose own name is a credential name, relative to dir. */
function secretsUnder(dir) {
  const found = [];
  (function walk(d) {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (isSecretPath(e.name)) found.push(p.slice(dir.length + 1));
      else if (e.isDirectory() && !e.isSymbolicLink()) walk(p);
    }
  })(dir);
  return found;
}
function removeSecrets(dir) { for (const p of secretsUnder(dir)) rmSync(join(dir, p), { recursive: true, force: true }); }
export { COPY_SHAPES, isEnvPath, isPathValue, isPublic, isSecretKey, MIN_SECRET_KEY_VALUE, MIN_VALUE, PATTERN_HIT, PEM_ARMOUR, PUBLIC_SHAPES, removeSecrets, searcher, secretsUnder, SKIP_BINARY_OVER, SYSTEM_ENV };
