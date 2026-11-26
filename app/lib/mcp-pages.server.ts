/**
 * The hosted MCP's HTML views: the consent screen, the reviewer box and every
 * error page of the connect flow, with the headers they are served under.
 * Moved out of app/routes/mcp.$.tsx unchanged (US-64, lead S-11).
 */
import { isLoopbackRedirect, KNOWN_CLIENTS, type McpClient } from './mcp-clients.server';
import { type McpProvider, providerLabel, providerRevokeUrl } from './mcp-providers.server';
import { reviewerOffered, reviewerRefreshToken } from './mcp-reviewer.server';
import { REPO_PUBLIC } from '../../packages/health-core/src/plan';

/** No CORS headers, ever (design §6) — and no caching of an OAuth answer. */
export const NO_STORE = { 'Cache-Control': 'no-store', Pragma: 'no-cache' };

/** Client-supplied text reaches HTML here, so it is escaped, never trusted. */
function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

export function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // `frame-ancestors 'none'` is not covered by `default-src`: without it the
      // consent screen can be framed and clickjacked into a connection the user
      // never meant to give. `X-Frame-Options` says the same to older browsers.
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      // `same-origin`, NOT `no-referrer`: under `no-referrer` a browser posts the
      // consent form with `Origin: null`, which `originRejected` refuses — the
      // consent step could not complete in a real browser at all. That Origin
      // check IS the CSRF defence on this POST: the cookie is SET by it, so
      // SameSite protects nothing here, and browsers attach an Origin to every
      // cross-site POST (as `null` when the referrer is suppressed).
      'Referrer-Policy': 'same-origin',
      ...NO_STORE,
      ...headers,
    },
  });
}

/**
 * One shell for every state the connect flow renders: the consent screen and
 * every error. Self-contained — inline styles only, so the `default-src 'none';
 * style-src 'unsafe-inline'` policy above needs no widening, and no webfont.
 */
export function page(title: string, inner: string, lead = ''): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
:root{--bg:#f7f7f5;--card:#fff;--line:#e6e5e0;--ink:#16302a;--dim:#5f6b66;
--brand:#00a38b;--brand-ink:#00806d;--err:#b42318;--radius:14px}
@media (prefers-color-scheme:dark){:root{--bg:#101413;--card:#181d1c;--line:#2a3230;
--ink:#eef2f0;--dim:#9aa8a3;--brand:#26bfa6;--brand-ink:#26bfa6;--err:#f97066}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.55 -apple-system,
BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
-webkit-font-smoothing:antialiased;
padding:calc(env(safe-area-inset-top) + 28px) calc(env(safe-area-inset-right) + 16px)
calc(env(safe-area-inset-bottom) + 40px) calc(env(safe-area-inset-left) + 16px)}
main{max-width:30rem;margin-inline:auto}
.mark{display:flex;align-items:center;gap:8px;font-size:14px;letter-spacing:.02em;
color:var(--dim);margin-bottom:22px}
.dot{width:9px;height:9px;border-radius:50%;background:var(--brand);flex:none}
.card{background:var(--card);border:1px solid var(--line);border-radius:var(--radius);
padding:26px 22px}
h1{margin:0 0 10px;font-size:1.5rem;line-height:1.25;letter-spacing:-.015em}
p{margin:0 0 14px}
.lede{color:var(--dim)}
.who{font-weight:600;color:var(--ink)}
form{margin:0}
.pick{display:flex;flex-direction:column;gap:10px;margin:22px 0 4px}
button{display:flex;width:100%;min-height:52px;align-items:center;gap:12px;
font-weight:600;font-size:16px;line-height:1.2;font-family:inherit;color:#fff;background:var(--brand);border:0;
border-radius:12px;padding:14px 18px;cursor:pointer;text-align:left}
button:hover{background:var(--brand-ink)}
button:focus-visible{outline:2px solid var(--ink);outline-offset:2px}
button svg{flex:none}
h2{margin:26px 0 10px;font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;
color:var(--dim)}
ul{margin:0;padding:0;list-style:none}
li{position:relative;padding:0 0 0 20px;margin-bottom:9px;color:var(--ink)}
li::before{content:"";position:absolute;left:2px;top:.62em;width:6px;height:6px;
border-radius:50%;background:var(--brand)}
.fine{margin-top:22px;padding-top:18px;border-top:1px solid var(--line);
font-size:14px;color:var(--dim)}
.fine p{margin:0 0 10px}
.fine p:last-child{margin:0}
a{color:var(--brand-ink);text-decoration:underline;text-underline-offset:2px}
.rev{overflow-wrap:anywhere}
.lead{margin-bottom:16px;border-color:var(--brand)}
.lead h2{margin:0 0 8px;font-size:1.15rem;text-transform:none;letter-spacing:0;color:var(--ink)}
label{display:block;margin:14px 0 6px;font-size:14px;font-weight:600}
input{display:block;width:100%;min-height:48px;font-family:inherit;font-size:16px;color:var(--ink);
background:var(--bg);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
input:focus-visible{outline:2px solid var(--brand);outline-offset:1px}
.reviewer button{margin-top:18px;justify-content:center}
.err{color:var(--err);font-weight:600}
</style>
</head><body><main>
<div class="mark"><span class="dot"></span>Health by Dr Brad</div>
${lead ? `<div class="card lead">${lead}</div>` : ''}
<div class="card"><h1>${escapeHtml(title)}</h1>${inner}</div>
</main></body></html>`;
}

export function htmlError(message: string, headers: Record<string, string> = {}): Response {
  return html(page('Something went wrong', `<p class="lede">${escapeHtml(message)}</p>`), 400, headers);
}

/** A provider's own glyph, drawn inline: no image request, no CSP widening. */
function providerMark(provider: McpProvider): string {
  if (provider === 'dropbox') {
    return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="#fff">
<path d="M6 2 0 6l6 4 6-4-6-4Zm12 0-6 4 6 4 6-4-6-4ZM0 14l6 4 6-4-6-4-6 4Zm18-4-6 4 6 4 6-4-6-4ZM6 19.5 12 23.5l6-4-6-4-6 4Z"/></svg>`;
  }
  return `<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" fill="#fff">
<path d="M8.7 2.2h6.6l6.6 11.4h-6.6L8.7 2.2Z"/><path d="M7.1 4 .5 15.4l3.3 5.7 6.6-11.4L7.1 4Z"/>
<path d="M5.6 15.9h16.3l-3.3 5.7H2.3l3.3-5.7Z"/></svg>`;
}

/** The host of a URL, or '' when it is not one. */
function hostOf(uri: string): string {
  try {
    return new URL(uri).host;
  } catch {
    return '';
  }
}

/**
 * What we can actually vouch for about the app asking. `client_name` is
 * whatever the registrant typed, so the screen says the one true thing beside
 * it: a pinned vendor client is known; a CIMD client is only as good as the
 * host that published its metadata; a self-registered client is worth nothing
 * but the place it sends the user back to, and the redirect list is
 * allow-listed, so that place is real.
 */
function clientSource(client: McpClient): string {
  if (KNOWN_CLIENTS.has(client.clientId)) return 'it is a known client';
  const metadataHost = client.clientId.startsWith('https://') ? hostOf(client.clientId) : '';
  if (metadataHost) return `it is registered at ${metadataHost}`;
  if (client.redirectUris.some(isLoopbackRedirect)) return 'it returns you to a program on this computer';
  const hosts = [...new Set(client.redirectUris.map(hostOf).filter(Boolean))];
  return hosts.length > 0 ? `it returns you to ${hosts.join(' or ')}` : 'we can verify nothing about it';
}

/**
 * The app reviewer box (US-32 AC38, AC49): open, and above everything else on the
 * page, because the reviewer pressed the first button inside two seconds. It
 * exists only for the exact pinned Claude and Claude Code clients, only while
 * Anthropic's review is pending, only while the reviewer
 * secrets are set, and only with Dropbox on offer. `error` is our own
 * sentence; what was typed is never echoed.
 */
function reviewerBox(state: string, error?: string): string {
  return `<h2>Anthropic reviewers: sign in here</h2>
<p class="lede">For Anthropic’s connector review only. This is not your Dropbox or Google password.</p>
${error ? `<p class="err" role="alert">${escapeHtml(error)}</p>` : ''}<form method="post" class="reviewer">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<input type="hidden" name="reviewer" value="1">
<label for="reviewer-username">Username</label>
<input id="reviewer-username" type="text" name="username" pattern="[^@]*" autocomplete="off" autocapitalize="none" spellcheck="false" required>
<label for="reviewer-password">Password</label>
<input id="reviewer-password" type="password" name="password" autocomplete="off" required>
<button type="submit"><span>Sign in</span></button>
</form>`;
}

/**
 * What the user is actually agreeing to, in the words §1 approved. The
 * assistant's name is text it chose, so it is escaped.
 */
export function consentPage(client: McpClient, offers: Array<{ provider: McpProvider; state: string }>, error?: string): string {
  const dropbox = offers.find(({ provider }) => provider === 'dropbox');
  const reviewer = dropbox && reviewerOffered(client.clientId, dropbox.provider) ? reviewerBox(dropbox.state, error) : '';
  // The custody clause follows the TOKEN, not the whole feature: a token set
  // with a malformed password hash keeps the box off but still sits on this server.
  const reviewerTokenHeld = reviewerRefreshToken() !== '';
  // One form per provider, each carrying its own sealed state. A button is a
  // choice of cloud, and the choice is sealed the moment it is offered.
  const buttons = offers
    .map(
      ({ provider, state }) => `<form method="post">
<input type="hidden" name="state" value="${escapeHtml(state)}">
<button type="submit">${providerMark(provider)}<span>Continue to ${escapeHtml(providerLabel(provider))}</span></button>
</form>`,
    )
    .join('\n');
  const revoke = offers.map(({ provider }) => providerRevokeUrl(provider)).join(' or ');
  // Name only the clouds actually on offer: the sentence follows the buttons.
  const clouds = offers.map(({ provider }) => providerLabel(provider)).join(' or ');
  return page(
    'Where do you want to keep your health record?',
    `${reviewer ? '<h2>Everyone else: choose where your record is kept</h2>\n' : ''}<p class="lede"><span class="who">${escapeHtml(client.name)}</span> wants to connect to your health record.</p>
<p class="lede">That name is the app’s own, not ours. What we can tell you about it: ${escapeHtml(clientSource(client))}.</p>
<p class="lede">Your health record is yours, and yours alone. Keep it in your own ${escapeHtml(clouds)}. Your assistant reads and writes one file there, plus a temporary imports folder while an import is pending. Our server never stores your health record. We keep a count of connector use: which tool ran, from which assistant, whether it worked, and when.${reviewerTokenHeld ? ' While Anthropic’s connector review is pending, we also hold the Dropbox credential of one invented reviewer account.' : ''}</p>
<div class="pick">${buttons}</div>
${offers.some(({ provider }) => provider === 'google') ? '<p class="lede">Importing lab files: drop a file into the chat on either cloud, on any device, and your assistant reads it. With Dropbox you can also put files in the folder; with Google Drive the folder cannot be read, so the chat or the website’s upload are the ways in.</p>' : ''}
<h2>What the assistant can do</h2>
<ul>
<li>Read your record and produce your plan.</li>
<li>Add measurements and lab results.</li>
<li>Correct a recent value, after showing you what it would change. The old value is kept.</li>
<li>Update your sex, birth year, birth month and height, after showing you the change.</li>
<li>File a bug report as ${REPO_PUBLIC ? 'a public issue on GitHub' : 'an issue on the project’s GitHub, which becomes public when that GitHub is public again'}, in your words, without your health values, after
showing you what it would say. The check refuses numbers written near a metric name, email addresses,
phone numbers, file names and links with a query string, but it cannot recognise a diagnosis written in prose,
so read what it shows you before you say yes.</li>
<li>File the results from a lab report, a photo of one or a clinic letter you drop into the chat. Your assistant
reads the file itself; the file never reaches our server. Only the values it read do, in memory for one request,
and they are written to your own folder, never kept by us. Nothing is written to your record until you confirm
what it read; the candidates wait in a pending file in your own folder for an hour.</li>
<li>Import lab PDFs, images or a ZIP you put in the Dropbox folder root. At the extract step, before you confirm
anything, those files pass through our server and go to Anthropic’s API for extraction. We keep none of them;
Anthropic’s API terms say they do not train on them, and their privacy centre says inputs and outputs are
deleted within 30 days, kept longer only to enforce their usage policy or comply with the law
(<a href="https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data">their policy</a>).
Nothing is written to your record until you confirm what it found; the candidates wait in a pending file in your
own folder for an hour. What it cannot read, it says why in plain words. The next time you ask, it offers files
in the folder that are not yet in your record. The website’s upload instead reads the PDF in your browser.</li>
</ul>
<div class="fine">
<p>We count calls, never your values.
<a href="https://drstanfield.com/pages/connector-privacy">Privacy notice</a> ·
<a href="https://drstanfield.com/pages/roadmap">Setup guide</a></p>
<p>Your record stays in your own storage. To answer one call, our server unseals the cloud credential your
assistant holds, opens your folder with it, and holds your record in server memory for the length of that
request. It stores none of it and keeps no copy. If you would rather no server saw your record at all, the
same tools run as a program on your own computer, straight against your own file, with nothing of ours in
between: <a href="https://drstanfield.com/pages/roadmap">see the setup guide</a>.</p>
<p class="rev">Disconnect any time at ${escapeHtml(revoke)}.</p>
<p>Educational, not medical advice.</p>
</div>`,
    reviewer,
  );
}
