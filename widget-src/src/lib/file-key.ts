/**
 * A read file's identity in this pick: its bytes' hash, else its place in the
 * pick. Never its name alone, which two files can share (a portal's every
 * `Results.pdf`): the rows each file's values wrote are grouped by it (US-14
 * AC10). Its own module: a value import of upload-pipeline pulls the upload API.
 */
export function fileKey(result: { contentHash?: string }, index: number): string {
  return result.contentHash || `#${index}`;
}
