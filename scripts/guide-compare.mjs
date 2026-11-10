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

export const norm = (s) =>
  s.split(/(<[^>]*>)/).map((part, i) => (i % 2 ? part : decodeQuotes(part))).join('')
    .replace(/<(\w+)([^>]*?)\s*\/>/g, '<$1$2></$1>') // self-closing -> open+close
    .replace(/<[^>]+>/g, (tag) => tag.toLowerCase())
    .replace(/>\s+</g, '><');
