/** 'sha256-<hex>' content fingerprint — names the blob + detects corruption. The upload hashes
 *  each file before it is read (US-12 AC27); the hash travels with its result. The archive step
 *  itself is health-core's (upload-plan.ts, upload-save.ts, design 12c). */
export async function sha256Blob(blob: Blob): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256-${hex}`;
}
