// norm() for publish-guides.mjs: a guide body reduced for comparing with the live
// Shopify copy. Comparing only; the rendered HTML is what is written. Pure, so it
// is testable: publish-guides.mjs needs Shopify secrets at import.
//
// Shopify lowercases attribute names (viewBox -> viewbox) and inserts newlines
// between tags on save, so the comparison expands self-closing tags, lowercases
// every tag and ignores inter-tag whitespace. The builder escapes quotes and a
// re-serialised live body may not, so quote entities are decoded in text between
// tags. Never inside a tag: there `"` ends an attribute and `&quot;` does not.
const decodeQuotes = (s) => s.replace(/&(quot|#34);/g, '"').replace(/&(apos|#39);/g, "'");

// A tag lowercased, and a self-closing one expanded to open+close.
const normTag = (tag) => {
  const t = tag.toLowerCase();
  const name = /^<(\w+)/.exec(t)?.[1];
  return name && t.endsWith('/>') ? `${t.slice(0, -2).trimEnd()}></${name}>` : t;
};

// One linear pass; a regex that looks for a tag's end rescans to the end of the
// string from every unclosed <. A tag runs from < to the first > outside quotes, so
// href="a>b" is one tag. An unclosed tag runs to the end and is left as written:
// that only compares stricter.
export const norm = (s) => {
  let out = '';
  let start = 0;
  for (let i = s.indexOf('<'); i !== -1; i = s.indexOf('<', start)) {
    let j = i + 1;
    for (let quote = ''; j < s.length && (quote || s[j] !== '>'); j += 1) {
      if (quote ? s[j] === quote : s[j] === '"' || s[j] === "'") quote = quote ? '' : s[j];
    }
    out += decodeQuotes(s.slice(start, i)) + (j < s.length ? normTag(s.slice(i, j + 1)) : s.slice(i));
    start = j + 1;
  }
  return (out + decodeQuotes(s.slice(start))).replace(/>\s+</g, '><');
};
