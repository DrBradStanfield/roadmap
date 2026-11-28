// A guide's front matter, read one way for publish-guides.mjs (the article title and
// summary) and build-guide-html.mjs (the page's JSON-LD and its link) (US-38 AC3a).

// A value wrapped in double quotes, with no unescaped quote between them, loses them,
// and its \" and \\ become " and \ in one pass. Any other value, single-quoted
// included, is kept as written.
const unquote = (value) => {
  const quoted = /^"((?:[^"\\]|\\[\s\S])*)"$/.exec(value);
  return quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : value;
};

// Only the --- block at the top of the file, one `key: value` per line. The key is the
// text before the first colon, trimmed, so an indented key counts; the last line with
// a key wins, and a line with no colon is left out. Null when the file has no block,
// or an empty one: two --- lines are no block, so a later --- rule cannot close it.
export const frontMatter = (md) => {
  const block = /^---\n(?!---\n)([\s\S]*?)\n---\n/.exec(md);
  return block && Object.fromEntries(block[1].split('\n').filter((l) => l.includes(':')).map((l) => {
    const i = l.indexOf(':');
    return [l.slice(0, i).trim(), unquote(l.slice(i + 1).trim())];
  }));
};
