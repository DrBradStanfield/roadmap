// Agent channel file checks (US-63 AC18): which attachments `fetch` may save, and whether the downloaded bytes
// are what the extension says. The file's bytes are the authority: the signature must match the extension, and
// an image's width and height come from its own header (PNG IHDR, GIF, JPEG SOF, WebP VP8/VP8L/VP8X). Discord's
// declared content_type, width and height are checked when present and may not contradict the bytes; their
// absence never refuses. Each function returns the reason to refuse, or null. Imported by agent-channel-files.mjs.

const MB = 1024 * 1024;
const MAX_SIDE = 8192;
const TEXT = new Set(['md', 'txt', 'csv', 'json']);
/** Image extension → its format, as the signature and the declared content type name it. */
const IMAGES = { png: 'png', jpg: 'jpeg', jpeg: 'jpeg', gif: 'gif', webp: 'webp' };

/** The download cap for an allowed extension, in bytes: 2 MB for text, 8 MB for an image; null if refused. */
export const capOf = (ext) => (TEXT.has(ext) ? 2 * MB : Object.hasOwn(IMAGES, ext) ? 8 * MB : null);

/** Why an extension is refused before anything is downloaded, or null. */
export function extensionProblem(ext) {
  if (ext === 'heic' || ext === 'heif') return '.heic and .heif images are not downloaded: ask for it to be resent as PNG or JPEG (iPhone screenshots are PNG)';
  if (capOf(ext) === null) return 'only .md, .txt, .csv and .json text and .png, .jpg, .jpeg, .gif and .webp images are downloaded';
  return null;
}

const declaredSide = (v) => (v === undefined || v === null ? null : v);
const mediaType = (t) => String(t).split(';')[0].trim().toLowerCase();

/** Why Discord's declared metadata refuses the attachment before any download, or null. Absent fields pass. */
export function declaredProblem(ext, att) {
  if (att.content_type !== undefined && att.content_type !== null) {
    const type = mediaType(att.content_type);
    const ok = TEXT.has(ext) ? type.startsWith('text/') || type === 'application/json' : type === `image/${IMAGES[ext]}`;
    if (!ok) return `the declared content type contradicts the .${ext} extension; not downloaded`;
  }
  if (TEXT.has(ext)) return null;
  const sides = [declaredSide(att.width), declaredSide(att.height)].filter((v) => v !== null);
  if (sides.some((v) => !Number.isInteger(v) || v < 1 || v > MAX_SIDE)) return `the declared width or height is not 1 to ${MAX_SIDE}; not downloaded`;
  return null;
}

/** The format the signature names, or null. */
function formatOf(b) {
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return 'gif';
  if (b.length >= 12 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

/** JPEG: walk the markers to the first start-of-frame (C0-CF, not the DHT C4, JPG C8 or DAC CC). */
function jpegSize(b) {
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) { i += 1; continue; }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null; // the image or its scan began before any frame header
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return i + 9 <= b.length ? [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)] : null;
    }
    i += 2 + len;
  }
  return null;
}

/** WebP: the first chunk is VP8 (lossy), VP8L (lossless) or VP8X (extended). */
function webpSize(b) {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) {
    return [b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff];
  }
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return [(bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1];
  }
  if (chunk === 'VP8X' && b.length >= 30) return [b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1];
  return null;
}

/** [width, height] from the header of a file whose signature is `format`, or null when it cannot be read. */
function sizeOf(format, b) {
  if (format === 'png') return b.length >= 24 && b.toString('latin1', 12, 16) === 'IHDR' ? [b.readUInt32BE(16), b.readUInt32BE(20)] : null;
  if (format === 'gif') return b.length >= 10 ? [b.readUInt16LE(6), b.readUInt16LE(8)] : null;
  return format === 'jpeg' ? jpegSize(b) : webpSize(b);
}

/** Why the downloaded bytes refuse the attachment, or null: the bytes are the authority. */
export function bytesProblem(ext, bytes, att) {
  if (TEXT.has(ext)) {
    if (bytes.includes(0)) return 'the text file holds a NUL byte; not saved';
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return 'the text file is not valid UTF-8; not saved'; }
    return null;
  }
  const want = IMAGES[ext];
  if (formatOf(bytes) !== want) return `the file's bytes are not a ${want.toUpperCase()} image, as the .${ext} extension says; not saved`;
  const size = sizeOf(want, bytes);
  if (!size) return `the ${want.toUpperCase()} header cannot be read; not saved`;
  const [w, h] = size;
  if (![w, h].every((v) => v >= 1 && v <= MAX_SIDE)) return `the image is ${w}x${h}; each side must be 1 to ${MAX_SIDE}; not saved`;
  const [dw, dh] = [declaredSide(att.width), declaredSide(att.height)];
  if ((dw !== null && dw !== w) || (dh !== null && dh !== h)) return `the declared width or height contradicts the file's header (${w}x${h}); not saved`;
  return null;
}
