/**
 * Which archived original opens in a preview, on the web and the iPhone (US-14 AC3, AC14).
 * The web opens it as a blob: URL in a tab, which runs with the page's origin, so only a
 * passive kind may open: never an SVG, HTML, XML or anything else that can carry script.
 */

/** The passive kinds, each with its one type; the first extension names a file that has none. */
export const VIEWABLE_KINDS = [
  { type: 'application/pdf', extensions: ['pdf'] },
  { type: 'image/png', extensions: ['png'] },
  { type: 'image/jpeg', extensions: ['jpeg', 'jpg'] },
  { type: 'image/heic', extensions: ['heic'] },
] as const satisfies readonly { type: string; extensions: readonly string[] }[];

/** The name to preview an original under, and the type to give its bytes. */
interface Preview {
  name: string;
  type: (typeof VIEWABLE_KINDS)[number]['type'];
}

/** The text after a name's last dot, or null when it has none: as iOS reads one (NSString
 *  pathExtension), a leading dot, an empty ending or one with a space is no extension. */
function extensionIn(name: string): string | null {
  const dot = name.lastIndexOf('.');
  const ext = name.slice(dot + 1);
  return dot > 0 && ext !== '' && !ext.includes(' ') ? ext.toLowerCase() : null;
}

/** A type as stored or served: lower-cased, its parameters (`; charset=…`) cut. */
function bareType(type: string | null): string {
  return (type ?? '').split(';')[0].trim().toLowerCase();
}

/**
 * The preview for an original, or null to download it (US-14 AC14). The extension decides;
 * with none, the stored type does. A type that is set must be the kind's own, exactly, or
 * application/octet-stream (Dropbox and GitHub serve untyped bytes). `servedType` is the
 * type the cloud returned the bytes with, when the caller has them.
 */
export function originalPreview(fileName: string, storedType: string | null, servedType = ''): Preview | null {
  const name = fileName.slice(fileName.lastIndexOf('/') + 1);
  const ext = extensionIn(name);
  const kind = ext !== null
    ? VIEWABLE_KINDS.find((k) => k.extensions.some((e) => e === ext))
    : VIEWABLE_KINDS.find((k) => k.type === bareType(storedType));
  const agrees = (type: string | null) => ['', 'application/octet-stream', kind?.type].includes(bareType(type));
  if (!kind || !agrees(storedType) || !agrees(servedType)) return null;
  return { name: ext !== null ? name : `${name || 'document'}.${kind.extensions[0]}`, type: kind.type };
}
