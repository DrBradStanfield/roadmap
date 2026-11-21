/**
 * What the page holds of a pick, for the shared Save (storage/upload-save-store.ts): each file's original by its id in
 * the upload state, as the web holds it (lib/upload-read.ts `Held`): a picked File, or a ZIP member's entry, inflated
 * only as its original is written. The cloud write is the store's. Not mounted yet (PR 3b).
 */
import type { Original, WebUploadIO } from '../storage/upload-save-store';
import type { Held } from './upload-read';

export function webUploadIO(held: Held): WebUploadIO {
  const original = (fileId: string): Original | null => {
    const h = held.files.get(fileId);
    const file = h?.file;
    if (file) return () => Promise.resolve(file);
    const entry = h?.entry;
    return entry ? () => entry.async('blob') : null;
  };
  return {
    holds: (fileId) => original(fileId) !== null,
    original,
    // The File's own type, as the store's document save writes it today; a member read as a File has none.
    mimeType: (fileId) => held.files.get(fileId)?.file?.type ?? '',
  };
}
