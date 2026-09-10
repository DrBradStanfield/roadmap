/**
 * GitHub storage adapter — the developer / privacy backend (implementation plan
 * §4.1). GitHub's OAuth token endpoints are NOT CORS-enabled and require a
 * client secret, so a browser PKCE flow is impossible. Instead the user pastes a
 * **fine-grained personal access token** scoped to ONE repository with Contents
 * read+write and Metadata read (implicit on every fine-grained PAT, and what
 * the repo-visibility guard reads) — repo-scoped by construction. This is an
 * advanced, dev-audience tier, not the grandma flow.
 *
 * Storage: record files (`health-roadmap.json`, `chat-history.json`, …) live on
 * the repo's default branch; each file's `sha` is its optimistic-concurrency
 * version token. Uploaded documents live under `documents/`.
 *
 * LIMIT: the GitHub Contents API caps a file at ~1 MB. Fine for the JSON record;
 * a large lab-PDF upload could exceed it (the read returns empty content). The
 * dev/privacy audience can live with that; the Git Data blob API would lift the
 * cap later if needed. See the implementation build log.
 */
import {
  ConflictError,
  StorageError,
  type ReadResult,
  type StorageAdapter,
  type WriteResult,
} from '@roadmap/health-core';
import { getJson, setJson, safeRemoveItem } from '../lib/storage';
import { bytesToBase64, base64ToBytes } from '../lib/base64';

const CONFIG_KEY = 'health_roadmap_github';
const API = 'https://api.github.com';

export interface GitHubConfig {
  /** Fine-grained PAT, scoped to one repo, Contents read+write. Stored locally only. */
  token: string;
  owner: string;
  repo: string;
}

function loadConfig(): GitHubConfig | null {
  return getJson<GitHubConfig>(CONFIG_KEY);
}

export class GitHubAdapter implements StorageAdapter {
  readonly id = 'github' as const;
  readonly label = 'GitHub';
  private config: GitHubConfig | null;
  private privacyCheck?: Promise<void>;

  /** First connect: pass the pasted config. Reconnect: omit, loads from storage. */
  constructor(config?: GitHubConfig) {
    this.config = config ?? loadConfig();
  }

  isConnected(): boolean {
    return !!(this.config?.token && this.config.owner && this.config.repo);
  }

  /**
   * The account's primary verified email, read HERE in the browser for the
   * reminders opt-in (US-17 AC7): only the address crosses to Brad's server,
   * never the PAT (which holds write access to the repo the health data lives
   * in). Null when the fine-grained token lacks the account permission "Email
   * addresses: read-only" — the control then asks for the address once.
   * Throws on a transient failure (the caller retries next visit).
   */
  async accountEmail(): Promise<string | null> {
    if (!this.config?.token) throw new StorageError('GitHub is not connected.');
    const res = await fetch(`${API}/user/emails`, { headers: this.headers() });
    if (res.status === 403 || res.status === 404) return null;
    if (!res.ok) throw new StorageError(`GitHub email read failed (${res.status}).`);
    const emails = (await res.json()) as Array<{ email: string; primary: boolean; verified: boolean }>;
    const primary = emails.find((e) => e.primary && e.verified) ?? emails.find((e) => e.verified);
    return primary ? primary.email.toLowerCase() : null;
  }

  /**
   * Validate the pasted token + repo against the repo endpoint, then persist.
   * No redirect — the credential is user-supplied, not OAuth.
   */
  async connect(): Promise<void> {
    if (!this.config?.token || !this.config.owner || !this.config.repo) {
      throw new StorageError('GitHub needs a token, owner, and repo.');
    }
    await this.ensurePrivate();
    setJson(CONFIG_KEY, this.config);
  }

  async disconnect(): Promise<void> {
    this.config = null;
    this.privacyCheck = undefined;
    safeRemoveItem(CONFIG_KEY);
  }

  // --- file ops -------------------------------------------------------------

  async read(fileName: string): Promise<ReadResult> {
    const res = await fetch(this.contentsUrl(fileName), { headers: this.headers() });
    if (res.status === 404) return { body: null, version: null };
    if (!res.ok) throw new StorageError(`GitHub read failed (${res.status}): ${await res.text()}`);
    const json = (await res.json()) as { content?: string; sha: string };
    let body: unknown = null;
    if (json.content) {
      try {
        body = JSON.parse(new TextDecoder().decode(base64ToBytes(json.content))) as unknown;
      } catch (error) {
        throw new StorageError('GitHub read failed: file is not valid JSON (possible corruption).', undefined, error);
      }
    }
    return { body, version: json.sha ?? null };
  }

  async write(fileName: string, body: object, expectedVersion: string | null): Promise<WriteResult> {
    await this.ensurePrivate();
    const payload: Record<string, unknown> = {
      message: `Update ${fileName}`,
      content: bytesToBase64(new TextEncoder().encode(JSON.stringify(body))),
    };
    if (expectedVersion) payload.sha = expectedVersion; // omitted on first create
    const res = await fetch(this.contentsUrl(fileName), {
      method: 'PUT',
      headers: this.headers(),
      body: JSON.stringify(payload),
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
    if (!res.ok) throw new StorageError(`GitHub document read failed (${res.status}).`);
    const json = (await res.json()) as { content?: string };
    if (!json.content) throw new StorageError(`GitHub document empty or too large (>1 MB).`);
    return new Blob([base64ToBytes(json.content)]);
  }

  async writeDocument(ref: string, bytes: Blob): Promise<void> {
    await this.ensurePrivate();
    const content = bytesToBase64(new Uint8Array(await bytes.arrayBuffer()));
    const put = (sha?: string): Promise<Response> =>
      fetch(this.contentsUrl(ref), {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify(sha ? { message: `Update ${ref}`, content, sha } : { message: `Update ${ref}`, content }),
      });
    // Documents use write-once ids, so the create usually succeeds without a
    // sha; only on an overwrite conflict do we fetch the sha and retry once.
    let res = await put();
    if (res.status === 409 || res.status === 422) {
      const head = await fetch(this.contentsUrl(ref), { headers: this.headers() });
      const sha = head.ok ? ((await head.json()) as { sha?: string }).sha : undefined;
      res = await put(sha);
    }
    if (!res.ok) throw new StorageError(`GitHub document write failed (${res.status}).`);
  }

  // --- helpers --------------------------------------------------------------

  /**
   * Refuse a repository that is not private. Fails CLOSED: any status other
   * than a 200 saying `private: true` throws, because a token that can PUT
   * contents always carries Metadata:read, so this GET cannot legitimately
   * fail.
   */
  private async assertPrivate(): Promise<void> {
    if (!this.config) throw new StorageError('GitHub is not connected.');
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
    const repo = (await res.json()) as { private?: boolean };
    if (repo.private !== true) {
      throw new StorageError('This repository is public. Choose a private one, or your health record would be published.');
    }
  }

  /**
   * Once per adapter instance, before the first write — a saved connection
   * resumes with a bare `new GitHubAdapter()` and never calls connect(), so
   * the connect-time check alone would miss a repo connected before the guard
   * existed, or flipped public since. The PROMISE is memoised, so concurrent
   * first writes share one GET; a rejection clears it so a transient failure
   * re-checks next time. Reads stay ungated.
   */
  private ensurePrivate(): Promise<void> {
    if (!this.privacyCheck) {
      this.privacyCheck = this.assertPrivate().catch((error: unknown) => {
        this.privacyCheck = undefined;
        throw error;
      });
    }
    return this.privacyCheck;
  }

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
