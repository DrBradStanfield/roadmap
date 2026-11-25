/**
 * An uploaded original's content fingerprint. Which originals the archive keeps, and their rows, is the shared upload
 * Save's (health-core upload-plan.ts, upload-save.ts; US-14 AC10, AC11).
 */

/** 'sha256-<hex>' content fingerprint — names the blob + detects corruption. The upload hashes
 *  each file before it is read (US-12 AC27); the hash travels with its result. */
export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}
