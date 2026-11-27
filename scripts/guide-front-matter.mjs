// A guide's front-matter value as its YAML means it (US-38 AC3a). One wrapped in
// double quotes loses them, and its \" and \\ become " and \ in one pass. Any other
// value, single-quoted included, is kept as written. publish-guides.mjs (the article
// title and summary) and build-guide-html.mjs (the page's JSON-LD) both read it here.
export const unquote = (value) => {
  const quoted = /^"([\s\S]*)"$/.exec(value);
  return quoted ? quoted[1].replace(/\\(["\\])/g, '$1') : value;
};
