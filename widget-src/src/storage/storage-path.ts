/** Encode logical refs at the HTTP boundary, preserving URL's USVString coercion. */
export function encodeStoragePath(path: string): string {
  // Title truncation can leave half a surrogate pair. URL previously replaced
  // those units with U+FFFD; encodeURIComponent instead throws on them.
  const wellFormed = Array.from(path, character => {
    const unit = character.charCodeAt(0);
    return character.length === 1 && unit >= 0xd800 && unit <= 0xdfff ? '\ufffd' : character;
  }).join('');
  return wellFormed.split('/').map(encodeURIComponent).join('/');
}

/**
 * Where a raw-joined ref resolved before per-segment encoding (pre PR #186):
 * everything from the first `#` dropped, `%xx` text left for the server to
 * decode. Null when that is the same request as `url`. Reads only: US-14 AC1.
 */
export function legacyDocumentUrl(url: string, base: string, ref: string): string | null {
  const legacy = new URL(base + ref);
  legacy.hash = '';
  return legacy.href === new URL(url).href ? null : legacy.href;
}
