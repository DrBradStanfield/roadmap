// Lab files for "+" (US-52 AC10, AC11, AC13c): the lab reports in the person's
// Dropbox app folder, listed and downloaded for the upload review. The app
// folder is where the hosted connector reads lab files too (US-35 AC2,
// app/lib/mcp-import.server.ts, its web twin), by the same name rule; the
// phone also opens its subfolders. The token is the connected Dropbox's; no
// record session needs to be open.
import { StorageError } from '../../packages/health-core/src/adapter';
import { dropboxDownload, dropboxListTree, type DropboxTreeEntry } from '../../packages/health-core/src/dropbox-rest';
import { IMPORT_LIMITS } from '../../packages/health-core/src/import-hints';
import { FOLDER_IMPORT_EXTENSIONS, isImportableEntryName } from '../../packages/health-core/src/lab-extraction';
import { DOCUMENT_FOLDERS } from '../../packages/health-core/src/document-path';
import { accessToken, failed, refreshOn401 } from './cloud-adapters';

type LabEntry = { id: string; name: string; size: number; modified: string; folder: string; path: string };

/** A listing entry as the phone sees it: its parent folder, kept for the
 *  download, and its path below the folder that was listed (`listed`). */
const labEntry = (listed: string) => (entry: DropboxTreeEntry): LabEntry => ({
  id: entry.id, name: entry.name, size: entry.size, modified: entry.modified,
  folder: entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '',
  path: listed ? entry.path.slice(listed.length + 1) : entry.path,
});

/** The app's own folders at the app folder's root, never the person's reports:
 *  the connector's parked imports (PENDING_FOLDER, app/lib/mcp-import.server.ts)
 *  and the stored originals' folders. Hidden from the root's listing and its
 *  whole-folder read, and refused by every door (review R7). */
const APP_FOLDERS = new Set(['imports', ...Object.values(DOCUMENT_FOLDERS)].map((name) => name.toLowerCase()));
const isAppFolder = (path: string) => APP_FOLDERS.has(path.split('/')[0].toLowerCase());

/** A refusal in plain words, marked as one so Swift never reads it as a cloud
 *  failure's JSON, whatever the words start with (re-check R1). `gone`: the
 *  file is no longer where the listing put it. */
function refused(words: string, gone = false): Error {
  return new Error(JSON.stringify(gone ? { refused: words, gone } : { refused: words }));
}

/** Refuses a folder of the app's own (review R7). */
function ownFolder(folder: string): void {
  if (folder && isAppFolder(folder)) throw refused('That folder holds the app\'s own files, not reports to read.');
}

/** One folder's listing afresh, or the failure JSON. */
async function listTree(folder: string, recursive: boolean): Promise<DropboxTreeEntry[]> {
  try {
    return await refreshOn401(async (force) => dropboxListTree(await accessToken('dropbox', force), folder, recursive));
  } catch (error) {
    throw new Error(failed('dropbox', error));
  }
}

/** The lab files of one level's listing, newest first. The record and the app's
 *  own files are not lab files by name, so they never list. */
const labFilesOf = (folder: string, entries: DropboxTreeEntry[]): LabEntry[] => entries
  .filter((entry) => entry.kind === 'file' && isImportableEntryName(entry.name, FOLDER_IMPORT_EXTENSIONS))
  .map(labEntry(folder))
  .sort((a, b) => b.modified.localeCompare(a.modified));

/** The files the last whole-folder listing offered, by id: that read downloads
 *  them without listing each folder again (review R2). Any other listing ends it. */
let offered = new Map<string, LabEntry>();

/** One folder of the Dropbox app folder (`''` its root), as JSON `{ folders:
 *  [{ name, path }], files: [{ id, name, size, modified, folder, path }],
 *  hidden: [name] }`: its subfolders by name (hidden and __MACOSX ones left out,
 *  as a ZIP's are, and at the root the app's own, named in `hidden`) and its lab
 *  files newest first. Rejects with the failure JSON, or `{ refused }` for a
 *  folder of the app's own. */
export async function labFolderJson(folder: string): Promise<string> {
  ownFolder(folder);
  offered = new Map();
  const entries = await listTree(folder, false);
  const shown = entries.filter((entry) => entry.kind === 'folder' && !entry.name.startsWith('.') && entry.name.toLowerCase() !== '__macosx');
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  const own = (entry: DropboxTreeEntry) => folder === '' && isAppFolder(entry.path);
  const folders = shown.filter((entry) => !own(entry)).map((entry) => ({ name: entry.name, path: entry.path })).sort((a, b) => byName(a.name, b.name));
  const hidden = shown.filter(own).map((entry) => entry.name).sort(byName);
  return JSON.stringify({ folders, files: labFilesOf(folder, entries), hidden });
}

/** Every lab file in one folder and the folders inside it, as JSON
 *  `[{ id, name, size, modified, folder, path }]` (`path` below that folder),
 *  judged by that path (so a hidden or __MACOSX folder's files are left out, as
 *  a ZIP's are, and at the root the app's own folders' files). The phone orders
 *  and caps them (LabFileReader.maxFolderFiles). Rejects with the failure JSON,
 *  or `{ refused }` for a folder of the app's own. */
export async function labFolderFilesJson(folder: string): Promise<string> {
  ownFolder(folder);
  offered = new Map();
  const files = (await listTree(folder, true))
    .filter((entry) => entry.kind === 'file' && !(folder === '' && isAppFolder(entry.path)))
    .map(labEntry(folder))
    .filter((entry) => isImportableEntryName(entry.path, FOLDER_IMPORT_EXTENSIONS));
  offered = new Map(files.map((file) => [file.id, file]));
  return JSON.stringify(files);
}

/**
 * One file, by its id, only when a fresh listing offers it as a lab file
 * (review R3): the listing of the whole-folder read under way, or else a fresh
 * listing of its folder (`''` the root). An id from anywhere else, the
 * record's or the chat history's included, is refused before any download.
 * Answers the listing's name with the bytes, so the phone reads the file under
 * the name Dropbox gives it now. The web's size limit holds on the listing's
 * size and again on the bytes (review R5); an empty file is called empty
 * (re-check R2), and a listing with no size reads as 0. Refusals are
 * `{ refused }`, with `gone` when the file is no longer there; a cloud failure
 * is the failure JSON.
 */
export async function labFile(id: string, folder: string): Promise<{ name: string; bytes: ArrayBuffer }> {
  ownFolder(folder);
  const kept = offered.get(id);
  const entry = kept?.folder === folder ? kept : labFilesOf(folder, await listTree(folder, false)).find((file) => file.id === id);
  if (!entry) throw refused('That file is not a lab file in the folder any more. Refresh the list and try again.', true);
  const limit = (entry.name.toLowerCase().endsWith('.zip') ? IMPORT_LIMITS.zipMb : IMPORT_LIMITS.websiteFileMb) * 1024 * 1024;
  const check = (size: number) => {
    if (!(size > 0)) throw refused(`${entry.name} is empty.`);
    if (size > limit) throw refused(`${entry.name} is larger than the website's limit (${IMPORT_LIMITS.websiteFileMb} MB a file, ${IMPORT_LIMITS.zipMb} MB a ZIP).`);
  };
  check(entry.size);
  let bytes: Uint8Array<ArrayBuffer>;
  try {
    bytes = await refreshOn401(async (force) => dropboxDownload(await accessToken('dropbox', force), id));
  } catch (error) {
    if (error instanceof StorageError && error.status === 409) throw refused(`${entry.name} is not in the folder any more.`, true);
    throw new Error(failed('dropbox', error));
  }
  check(bytes.byteLength);
  return { name: entry.name, bytes: bytes.buffer };
}
