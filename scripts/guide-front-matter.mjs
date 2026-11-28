// A guide's front matter, read one way for publish-guides.mjs (the article title and
// summary) and build-guide-html.mjs (the page's JSON-LD and its link) (US-38 AC3a).

// A value wrapped in double quotes, with no unescaped quote between them, loses them,
// and its \" and \\ become " and \ in one pass. Any other value, single-quoted
// included, is kept as written.
const unquote = (value) => {
  const quoted = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(value);
  return quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : value;
};

// The block at the top, fenced as the builder on main fenced it: a first line of exactly ---, up to the next line of
// exactly --- (with a newline after it). One `key: value` per line, the key the text before the first colon as
// written; a line with no colon is left out. Null (no front matter) for an empty block, a key given twice, or a block
// line that is blank, starts with a space or a tab, or starts with ---: each may be a block that ran on into the
// body, which must give no metadata. So a file read here is one main's builder took, with the same block.
export const frontMatter = (md) => {
  const lines = md.split('\n');
  const end = lines.indexOf('---', 1);
  const block = lines.slice(1, end);
  if (lines[0] !== '---' || end < 2 || end === lines.length - 1 || block.some((l) => /^(?:---|\s|$)/.test(l))) return null;
  const pairs = block.filter((l) => l.includes(':')).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i), unquote(l.slice(i + 1).trim())];
  });
  const meta = Object.fromEntries(pairs);
  return Object.keys(meta).length === pairs.length ? meta : null;
};
