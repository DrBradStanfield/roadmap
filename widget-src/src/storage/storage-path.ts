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
