/**
 * GitHub storage adapter — the developer / privacy backend (implementation plan
 * §4.1). GitHub's OAuth token endpoints are NOT CORS-enabled and require a
 * client secret, so a browser PKCE flow is impossible. Instead the user pastes a
 * **fine-grained personal access token** scoped to ONE repository with Contents
 * read+write — repo-scoped by construction. This is an advanced, dev-audience
 * tier, not the grandma flow.
 *
 * Storage: the record file is `health-roadmap.json` on the repo's default
 * branch; the file `sha` is the optimistic-concurrency version token. Uploaded
 * documents live under `documents/`.
 *
 * LIMIT: the GitHub Contents API caps a file at ~1 MB. Fine for the JSON record;
 * a large lab-PDF upload could exceed it (the read returns empty content). The
 * dev/privacy audience can live with that; the Git Data blob API would lift the
 * cap later if needed. See the implementation build log.
 */
import type { RoadmapFile } from '@roadmap/health-core';
import {
  ConflictError,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from './adapter';
import { safeGetItem, safeRemoveItem, safeSetItem } from '../lib/storage';

const CONFIG_KEY = 'health_roadmap_github';
const FILE_PATH = 'health-roadmap.json';
const API = 'https://api.github.com';
const CHUNK = 0x8000; // 32 KB — keep String.fromCharCode arg lists small

export interface GitHubConfig {
  /** Fine-grained PAT, scoped to one repo, Contents read+write. Stored locally only. */
  token: string;
  owner: string;
  repo: string;
}

function loadConfig(): GitHubConfig | null {
  const raw = safeGetItem(CONFIG_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as GitHubConfig;
  } catch {
    return null; // corrupt — treat as not connected
  }
}

/** UTF-8 → base64 (the Contents API takes base64), chunked to avoid overflow. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/** base64 (possibly newline-wrapped, as GitHub returns) → bytes. */
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export class GitHubAdapter implements StorageAdapter {
  readonly id = 'github' as const;
  readonly label = 'GitHub';
  private config: GitHubConfig | null;

  /** First connect: pass the pasted config. Reconnect: omit, loads from storage. */
  constructor(config?: GitHubConfig) {
    this.config = config ?? loadConfig();
  }

  isConnected(): boolean {
    return !!(this.config?.token && this.config.owner && this.config.repo);
  }

  /**
   * Validate the pasted token + repo against the repo endpoint, then persist.
   * No redirect — the credential is user-supplied, not OAuth.
   */
  async connect(): Promise<void> {
    if (!this.config?.token || !this.config.owner || !this.config.repo) {
      throw new StorageError('GitHub needs a token, owner, and repo.');
    }
    const res = await fetch(`${API}/repos/${this.config.owner}/${this.config.repo}`, {
      headers: this.headers(),
    });
    if (res.status === 401 || res.status === 403) {
      throw new StorageError('GitHub rejected the token — check it has Contents read+write on this repo.');
    }
    if (res.status === 404) {
      throw new StorageError('GitHub repo not found — check owner/repo and that the token can see it.');
    }
    if (!res.ok) {
      throw new StorageError(`GitHub connect failed (${res.status}): ${await res.text()}`);
    }
    safeSetItem(CONFIG_KEY, JSON.stringify(this.config));
  }

  async disconnect(): Promise<void> {
    this.config = null;
    safeRemoveItem(CONFIG_KEY);
  }

  // --- file ops -------------------------------------------------------------

  async read(): Promise<ReadResult> {
    const res = await fetch(this.contentsUrl(FILE_PATH), { headers: this.headers() });
    if (res.status === 404) return { file: null, version: null };
    if (!res.ok) throw new StorageError(`GitHub read failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { content?: string; sha: string };
    let file: RoadmapFile | null = null;
    if (json.content) {
      try {
        file = JSON.parse(new TextDecoder().decode(base64ToBytes(json.content))) as RoadmapFile;
      } catch (error) {
        throw new StorageError('GitHub read failed: file is not valid JSON (possible corruption).', error);
      }
    }
    return { file, version: json.sha ?? null };
  }

  async write(file: RoadmapFile, expectedVersion: string | null): Promise<WriteResult> {
    const body: Record<string, unknown> = {
      message: `Update ${FILE_PATH}`,
      content: bytesToBase64(new TextEncoder().encode(JSON.stringify(file))),
    };
    if (expectedVersion) body.sha = expectedVersion; // omitted on first create
    const res = await fetch(this.contentsUrl(FILE_PATH), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    // 409 (sha out of date) / 422 (sha mismatch, or "already exists" on create) → conflict.
    if (res.status === 409 || res.status === 422) {
      throw new ConflictError(`GitHub write conflict: ${await res.text()}`);
    }
    if (!res.ok) throw new StorageError(`GitHub write failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { content?: { sha?: string } };
    const sha = json.content?.sha;
    if (!sha) throw new StorageError('GitHub write returned no sha.');
    return { version: sha };
  }

  async readDocument(ref: string): Promise<Blob> {
    const res = await fetch(this.contentsUrl(ref), { headers: this.headers() });
    if (!res.ok) throw new StorageError(`GitHub document read failed (${res.status}): ${ref}`);
    const json = (await res.json()) as { content?: string };
    if (!json.content) throw new StorageError(`GitHub document empty or too large (>1 MB): ${ref}`);
    return new Blob([base64ToBytes(json.content)]);
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    // Contents API needs the existing sha to overwrite; fetch it if present.
    let sha: string | undefined;
    const head = await fetch(this.contentsUrl(ref), { headers: this.headers() });
    if (head.ok) sha = ((await head.json()) as { sha?: string }).sha;
    const body: Record<string, unknown> = {
      message: `Update ${ref}`,
      content: bytesToBase64(new Uint8Array(await bytes.arrayBuffer())),
    };
    if (sha) body.sha = sha;
    const res = await fetch(this.contentsUrl(ref), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new StorageError(`GitHub document write failed (${res.status}): ${ref}`);
  }

  // --- helpers --------------------------------------------------------------

  private contentsUrl(path: string): string {
    if (!this.config) throw new StorageError('GitHub is not connected.');
    return `${API}/repos/${this.config.owner}/${this.config.repo}/contents/${path}`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.config?.token ?? ''}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }
}
