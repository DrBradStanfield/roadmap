// The live body's theme markers for build-master-html.mjs (US-50 AC9): read the live
// article body quote-aware, find the heading path each marker sat under, place it in the master.
// Moved verbatim from build-master-html.mjs in the file-size split (US-64 AC23).

const MARKERS = { 'roadmap-embed': ['edu'], 'cta-roadmap': ['edu'], 'cta-pf': ['edu', 'commerce'] };

/** Heading text reduced for matching across the old and new bodies: "3. Blood <b>Pressure</b>" -> "blood pressure". */
export const headingKey = (s) =>
  s.replace(/<[^>]+>/g, '').replace(/&[a-z#0-9]+;/gi, ' ').replace(/^\s*\d+\.\s+/, '').replace(/\s*\([^)]*\)\s*$/, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Push a heading onto its ancestor stack; returns the heading's path, outermost first. */
export const pushPath = (stack, h) => {
  while (stack.length && stack[stack.length - 1].level >= h.level) stack.pop();
  stack.push(h);
  return stack.slice();
};

const ENTITIES = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const decode = (s) => s.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/gi, (m, dec, hex, name) => {
  if (dec || hex) { const c = Number.parseInt(dec ?? hex, dec ? 10 : 16); return c === 160 ? ' ' : String.fromCodePoint(c); }
  return ENTITIES[name.toLowerCase()] ?? m;
});

/**
 * The live body's tags in order, read the way a browser reads them: a quoted
 * attribute value may hold ">" or "class=", so a regex up to the first ">"
 * could hide a marker (Codex R1). Comments are skipped; the first copy of a
 * repeated attribute wins.
 */
export function tokenizeTags(html) {
  const tags = [];
  for (let i = html.indexOf('<'); i !== -1; i = html.indexOf('<', i)) {
    if (html.startsWith('<!--', i)) { const e = html.indexOf('-->', i + 4); i = e === -1 ? html.length : e + 3; continue; }
    const m = /^<(\/?)([a-z][a-z0-9-]*)/i.exec(html.slice(i, i + 40));
    if (!m) { i++; continue; }
    const attrs = {};
    let j = i + m[0].length;
    while (j < html.length && html[j] !== '>') {
      if (/[\s/]/.test(html[j])) { j++; continue; }
      const name = /^[^\s"'>/=]+|^["'=]/.exec(html.slice(j))[0];
      j += name.length;
      while (/\s/.test(html[j] ?? '')) j++;
      let value = '';
      if (html[j] === '=') {
        j++;
        while (/\s/.test(html[j] ?? '')) j++;
        const q = html[j];
        if (q === '"' || q === "'") {
          const e = html.indexOf(q, j + 1);
          value = html.slice(j + 1, e === -1 ? html.length : e);
          j = e === -1 ? html.length : e + 1;
        } else {
          value = /^[^\s>]*/.exec(html.slice(j))[0];
          j += value.length;
        }
      }
      const key = name.toLowerCase();
      if (!Object.hasOwn(attrs, key)) attrs[key] = decode(value);
    }
    tags.push({ close: !!m[1], name: m[2].toLowerCase(), attrs, start: i, end: Math.min(j + 1, html.length) });
    i = j + 1;
  }
  return tags;
}

/** Visible text: tags removed (quote-aware), entities decoded. */
export const textOf = (html) => {
  let text = '';
  let at = 0;
  for (const t of tokenizeTags(html)) { text += html.slice(at, t.start); at = t.end; }
  return decode(text + html.slice(at));
};

const markersIn = (attrs) => (attrs.class ?? '').split(/\s+/).filter((t) => Object.hasOwn(MARKERS, t));

/** Theme markers in the live body, each with the heading path it sat under: carried, or dropped for this store. */
export function extractCarried(liveHtml, store) {
  const carried = [];
  const dropped = [];
  const stack = [];
  let path = null;
  let heading = null;
  let inHeading = 0;
  for (const t of tokenizeTags(liveHtml)) {
    const level = /^h([1-6])$/.exec(t.name)?.[1];
    // A marker on the heading element itself cannot be placed either (Codex R3).
    if (level && !t.close && !heading) { heading = { level: Number(level), from: t.end }; inHeading += markersIn(t.attrs).length; continue; }
    if (level && t.close && heading && Number(level) === heading.level) {
      const text = textOf(liveHtml.slice(heading.from, t.start)).trim();
      path = pushPath(stack, { key: headingKey(text), level: heading.level, text });
      heading = null;
      continue;
    }
    if (t.close) continue;
    for (const kind of markersIn(t.attrs)) {
      if (heading) inHeading++;
      else (MARKERS[kind].includes(store) ? carried : dropped).push({ kind, path, html: `<div class="${kind}"></div>` });
    }
  }
  if (inHeading) {
    throw new Error(`the live body has ${carried.length + dropped.length + inHeading} theme markers but only ${carried.length + dropped.length} outside a heading, where they can be placed`);
  }
  return { carried, dropped };
}

export const pathText = (path) => (path ? path.map((h) => h.text).join(' > ') : '(before the first heading)');
// Same headings outermost first; a level is compared where the carried path has one.
const samePath = (a, b) => a.length === b.length && a.every((h, i) => h.key === b[i].key && (h.level === undefined || h.level === b[i].level));

/** Insert each carried block at the end of the one master section whose heading path matches its own. */
export function placeCarried(blocks, carried) {
  const out = blocks.map((b) => ({ ...b, before: [], after: [] }));
  const unplaced = [];
  const fallbacks = [];
  const find = (path) => out.flatMap((b, i) => (b.path && samePath(path, b.path) ? [i] : []));
  const endOf = (at) => {
    let end = at;
    while (end + 1 < out.length && !(out[end + 1].level && out[end + 1].level <= out[at].level)) end++;
    return end;
  };
  for (const c of carried) {
    const hits = c.path ? find(c.path) : [];
    if (hits.length === 1) { out[endOf(hits[0])].after.push(c.html); continue; }
    let reason = hits.length ? `"${pathText(c.path)}" matches ${hits.length} master headings` : `the master has no heading "${pathText(c.path)}"`;
    // roadmap-embed renders nothing on the current theme; it is kept only as a position hint, so a lost heading falls back.
    const fb = !hits.length && c.kind === 'roadmap-embed' ? fallbackPlace(out, c.path, find, endOf) : null;
    if (fb?.at !== undefined) {
      out[fb.at][fb.side].push(c.html);
      fallbacks.push({ ...c, placed: fb.placed });
      continue;
    }
    if (fb?.reason) reason += `; ${fb.reason}`;
    unplaced.push({ ...c, reason });
  }
  return { html: out.flatMap((b) => [...b.before, b.html, ...b.after]).join('\n'), unplaced, fallbacks };
}

/** Where a roadmap-embed goes when its exact heading path is gone: the deepest surviving ancestor, else before References. */
function fallbackPlace(out, path, find, endOf) {
  if (!path) {
    const at = out.findIndex((b) => b.level);
    return at === -1 ? { reason: 'the master has no heading' } : { at, side: 'before', placed: `after the table of contents, before "${out[at].text}"` };
  }
  for (let k = path.length - 1; k >= 1; k--) {
    const hits = find(path.slice(0, k));
    if (hits.length > 1) return { reason: `its ancestor "${pathText(path.slice(0, k))}" matches ${hits.length} master headings` };
    if (hits.length === 1) return { at: endOf(hits[0]), side: 'after', placed: `end of "${pathText(out[hits[0]].path)}"` };
  }
  const refs = out.flatMap((b, i) => (b.level === 2 && b.key === 'references' ? [i] : []));
  return refs.length === 1 ? { at: refs[0], side: 'before', placed: 'before "References"' } : { reason: `the master has ${refs.length} References headings` };
}
