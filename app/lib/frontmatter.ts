// Frontmatter on the knowledge-base .md files (docs/blog, docs/guideline,
// docs/pathway): one `key: value` per line, JSON arrays on one line. Sentry-free,
// so scripts and tsx tools can import it.

/** The frontmatter keys, quotes stripped and one-line JSON arrays parsed. Null with no block. */
export function parseFrontmatter(content: string): Record<string, any> | null {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return null;

  const fm: Record<string, any> = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const [, key, rawValue] = kv;
    let value: any = rawValue.trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Parse JSON arrays
    if (value.startsWith('[')) {
      try { value = JSON.parse(value); } catch {}
    }

    fm[key] = value;
  }
  return fm;
}

/** The file without its frontmatter block: what the answer model reads (US-50 AC4). */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---[\s\S]*?---\n\n?/, '');
}
