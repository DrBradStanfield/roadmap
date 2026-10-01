#!/usr/bin/env tsx
// Mint and stage the OpenAI reviewer sign-in secrets (US-32 AC38; plan:
// docs/reviews/2026-10-01-chatgpt-reviewer-signin-plan.md §4.5). Brad runs it,
// from his own machine. Two modes, so a re-mint never touches the password:
//
//   npx tsx tools/mcp-reviewer-token.ts --password [--username <word>]
//     Generates the password, shows it ONCE in groups of four, and stages
//     MCP_REVIEWER_USERNAME and MCP_REVIEWER_PASSWORD_SHA256. Or, at the hidden
//     prompt, type the password already in the OpenAI form to stage it again.
//     A new password changes the generation and ends every reviewer session.
//
//   npx tsx tools/mcp-reviewer-token.ts --mint --expect <account_id> [--app-key <key>]
//     The confidential code flow with no redirect, exactly as live connections
//     are minted. Open the printed URL in a PRIVATE window, sign in as the
//     reviewer, press Allow, and paste the code Dropbox shows at the hidden
//     prompt; then the app secret from the Dropbox App Console at a second one.
//     The token is staged only if the account id Dropbox returns equals
//     <account_id> AND the app folder's record is the synthetic profile. On any
//     mismatch it stages nothing and revokes the new token. Prints "match" or
//     "mismatch".
//
// Staging: NAME=VALUE lines on stdin to `flyctl secrets import --stage -a
// health-tool-edu`, so they take effect on the next deploy. No secret value is
// ever written to disk, to a process argument, or to this script's output.
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import { ROADMAP_FILE_NAME } from '../packages/health-core/src/adapter';
import { DROPBOX_TOKEN_URL, dropboxRead } from '../packages/health-core/src/dropbox-rest';
import { DROPBOX_SCOPE } from '../app/lib/mcp-providers.server';
import { normalisePassword, passwordDigest } from '../app/lib/mcp-reviewer.server';

const FLY_APP = 'health-tool-edu';
/** 32 symbols, none of them l, 1, o or 0: typeable in a remote browser that cannot paste. */
export const PASSWORD_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
/** 26 symbols of 5 bits each: 130 bits. */
export const PASSWORD_LENGTH = 26;
const DEFAULT_USERNAME = 'openaireviewer';
/** The invented reviewer record's profile (plan §4.5). Anything else is not the reviewer's folder. */
const SYNTHETIC_PROFILE = { birthYear: 1979, heightCm: 178, sex: 'male' };
const DROPBOX_REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';

type Stage = (lines: string) => Promise<void>;

// --- the pure parts (tools/mcp-reviewer-token.test.ts) ----------------------

/** 256 is a multiple of 32, so the low five bits of a random byte are uniform over the alphabet. */
export function generatePassword(randomBytes: (size: number) => Buffer = crypto.randomBytes): string {
  return [...randomBytes(PASSWORD_LENGTH)].map((byte) => PASSWORD_ALPHABET[byte & 31]).join('');
}

export function isPassword(normalised: string): boolean {
  return normalised.length === PASSWORD_LENGTH && [...normalised].every((c) => PASSWORD_ALPHABET.includes(c));
}

export function groupPassword(password: string): string {
  return (password.match(/.{1,4}/g) ?? []).join(' ');
}

/** What `MCP_REVIEWER_PASSWORD_SHA256` holds: the server's own digest, as hex. */
export function passwordHash(password: string): string {
  return passwordDigest(password).toString('hex');
}

/** `NAME=VALUE` lines for `flyctl secrets import`. A value that could break a line is refused, not escaped. */
export function secretLines(secrets: Record<string, string>): string {
  return Object.entries(secrets)
    .map(([name, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(name) || typeof value !== 'string' || value === '' || /[\r\n]/.test(value)) {
        throw new Error(`refusing to stage ${name}: not a single-line value`);
      }
      return `${name}=${value}\n`;
    })
    .join('');
}

export function authorizeUrl(appKey: string): string {
  const url = new URL('https://www.dropbox.com/oauth2/authorize');
  url.searchParams.set('client_id', appKey);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('token_access_type', 'offline');
  url.searchParams.set('scope', DROPBOX_SCOPE);
  return url.toString();
}

/** Is this the invented reviewer record? Reads the parsed body; never writes it anywhere. */
export function isSyntheticRecord(body: unknown): boolean {
  const profile = ((body as { profile?: Record<string, unknown> } | null)?.profile ?? {}) as Record<string, unknown>;
  return Object.entries(SYNTHETIC_PROFILE).every(([key, value]) => profile[key] === value);
}

// --- the flows --------------------------------------------------------------

/** The --mint flow: 'match' stages the token; 'mismatch' stages nothing and revokes it. */
export async function mint(options: { expect: string; appKey: string; code: string; appSecret: string; stage: Stage }): Promise<'match' | 'mismatch'> {
  const { expect, appKey, code, appSecret, stage } = options;
  const res = await fetch(DROPBOX_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id: appKey, client_secret: appSecret }),
  });
  if (!res.ok) return 'mismatch';
  const token = (await res.json().catch(() => null)) as { access_token?: string; refresh_token?: string; account_id?: string } | null;
  if (!token?.refresh_token || !token.access_token) return 'mismatch';

  // The record is read only once the account is the expected one.
  const matches = token.account_id === expect
    && isSyntheticRecord(await dropboxRead(token.access_token, ROADMAP_FILE_NAME).then(({ body }) => body, () => null));
  if (!matches) {
    // Revokes this refresh token and its access tokens, not the account's app
    // link: a mistaken run on Brad's own account leaves his connections intact.
    await fetch(DROPBOX_REVOKE_URL, { method: 'POST', headers: { Authorization: `Bearer ${token.access_token}` } }).catch(() => null);
    return 'mismatch';
  }
  await stage(secretLines({ MCP_REVIEWER_DROPBOX_RT: token.refresh_token }));
  return 'match';
}

/** The --password flow. `existing` is a password re-entered to keep it; empty makes a new one. */
export async function password(options: { username: string; existing: string; stage: Stage; show: (grouped: string) => void }): Promise<void> {
  const { username, existing, stage, show } = options;
  if (!/^[a-z0-9]+$/.test(username)) throw new Error('the username must be one plain lowercase word');
  let chosen = normalisePassword(existing);
  if (chosen === '') {
    chosen = generatePassword();
    show(groupPassword(chosen));
  } else if (!isPassword(chosen)) {
    throw new Error(`that is not a reviewer password: ${PASSWORD_LENGTH} characters from the reviewer alphabet`);
  }
  await stage(secretLines({ MCP_REVIEWER_USERNAME: username, MCP_REVIEWER_PASSWORD_SHA256: passwordHash(chosen) }));
}

/** Pipe the lines to flyctl on stdin; nothing in its arguments but the app name. */
function stageWithFlyctl(lines: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('flyctl', ['secrets', 'import', '--stage', '-a', FLY_APP], { stdio: ['pipe', 'inherit', 'inherit'] });
    child.on('error', reject);
    child.on('close', (status) => (status === 0 ? resolve() : reject(new Error(`flyctl exited ${status}`))));
    child.stdin.end(lines);
  });
}

function prompt(question: string, { hidden = false } = {}): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      process.stdout.write(question);
      // Mute the echo: a hidden prompt must not print what is typed.
      (rl as unknown as { _writeToOutput: () => void })._writeToOutput = () => {};
    }
    rl.question(hidden ? '' : question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer.trim());
    });
  });
}

function flag(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

async function main(args: string[]): Promise<number> {
  if (args.includes('--password')) {
    const existing = await prompt('Password already in the OpenAI form, to keep it (Enter for a new one): ', { hidden: true });
    await password({
      username: flag(args, '--username') ?? DEFAULT_USERNAME,
      existing,
      stage: stageWithFlyctl,
      show: (grouped) => console.log(`\nThe reviewer password, shown once. Copy it to your credentials file and the OpenAI form:\n\n  ${grouped}\n`),
    });
    console.log(`Staged MCP_REVIEWER_USERNAME and MCP_REVIEWER_PASSWORD_SHA256 on ${FLY_APP}. They take effect on the next deploy.`);
    return 0;
  }
  if (args.includes('--mint')) {
    const expect = flag(args, '--expect');
    if (!expect) throw new Error('--mint needs --expect <account_id>, from your credentials file');
    const appKey = flag(args, '--app-key') || process.env.DROPBOX_APP_KEY || (await prompt('Dropbox app key (App Console): '));
    console.log(`\nOpen this in a PRIVATE window, sign in as the reviewer, and press Allow:\n\n  ${authorizeUrl(appKey)}\n`);
    const code = await prompt('Code Dropbox shows: ', { hidden: true });
    const appSecret = await prompt('Dropbox app secret (App Console): ', { hidden: true });
    const result = await mint({ expect, appKey, code, appSecret, stage: stageWithFlyctl });
    console.log(result);
    return result === 'match' ? 0 : 1;
  }
  console.error('Usage: npx tsx tools/mcp-reviewer-token.ts --password [--username <word>] | --mint --expect <account_id> [--app-key <key>]');
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (status) => process.exit(status),
    (error: Error) => {
      // The message is ours; no value is ever put into one.
      console.error(error.message);
      process.exit(1);
    },
  );
}
