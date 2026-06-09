/**
 * Shared UTF-8-safe base64 helpers. Chunked so large payloads don't blow the
 * `String.fromCharCode` argument-count limit. One stack-safe implementation so
 * no caller re-rolls the fragile `btoa(String.fromCharCode(...))` pattern (the
 * storage adapters used to each have their own copy).
 */
const CHUNK = 0x8000; // 32 KB

/** bytes → standard base64. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 (possibly newline-wrapped) → bytes, backed by a concrete ArrayBuffer. */
export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
