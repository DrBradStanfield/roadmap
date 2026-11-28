// A guide's front matter, read one way for publish-guides.mjs (the article title and
// summary) and build-guide-html.mjs (the page's JSON-LD and its link) (US-38 AC3a).

// A value wrapped in double quotes, with no unescaped quote between them, loses them,
// and its \" and \\ become " and \ in one pass. Any other value, single-quoted
// included, is kept as written.
const unquote = (value) => {
  const quoted = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(value);
  return quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : value;
};

// The block at the top: a first line of ---, up to the next line of --- or ..., each with only spaces or tabs
// after it (and a newline after the closing one). One `key: value` per line, the key trimmed; a line with no colon
// is left out. Null (no front matter) for an empty block, a block line starting with --- that is no fence (a CR, a
// fourth dash), no closing line, or a key given twice: each may have run into the body, which must give no metadata.
export const splitGuide = (md) => {
  const lines = md.split('\n');
  const end = lines.findIndex((l, i) => i > 0 && /^(?:---|\.\.\.)[ \t]*$/.test(l));
  const block = lines.slice(1, end);
  if (!/^---[ \t]*$/.test(lines[0]) || end < 2 || end === lines.length - 1 || block.some((l) => l.startsWith('---'))) return null;
  const pairs = block.filter((l) => l.includes(':')).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), unquote(l.slice(i + 1).trim())];
  });
  const meta = Object.fromEntries(pairs);
  return Object.keys(meta).length === pairs.length ? { meta, body: lines.slice(end + 1).join('\n') } : null;
};

export const frontMatter = (md) => splitGuide(md)?.meta ?? null;
