# Plan: a reviewer sign-in the risk engine cannot block (ChatGPT app, second rejection)

Status: v4, 2026-10-01. Three review rounds (§11 records every finding and its answer). Round 3's
verdict was BUILD WITH NAMED FIXES; v4 applies them. Next: Brad's go, then build. Story: US-32 AC38 (§5), written into
docs/user-stories.md FIRST when building. This document: net production LOC 0, nothing deleted.

## 1. What happened (evidence)

OpenAI rejected "Health by Dr Brad" v1.0.1 on 2026-09-30 with the same sentence as 1.0.0:
"We're unable to complete your sign-in or OAuth flow. Please ensure valid, working credentials are
included and that they include no additional setup or verification to access your service."

Our value-free OAuth funnel (`product_events`, US-32 AC34):

| UTC, 2026-09-30 | event | client | provider |
|---|---|---|---|
| 15:55:48.5 | mcp_authorize_shown | chatgpt | |
| 15:55:51.7 | mcp_consent_posted | chatgpt | dropbox |
| 16:02:41 | mcp_authorize_shown | chatgpt | |
| 16:03:05.1 | mcp_authorize_shown | chatgpt | |
| 16:03:06.5 | mcp_consent_posted | chatgpt | dropbox |

No `mcp_connect`, `mcp_connect_failed` or `mcp_authorize_refused` follows. Each attempt left our
server for Dropbox and never came back. The reviewer pressed Dropbox 3.1 s and 1.4 s after our page
rendered (Brad's own test, about 2 s): nobody reads this page, which is why the reviewer box must be
the first thing on it.

Dropbox's side: the reviewer account's mailbox (a plus-alias of the scratch mailbox, which the
reviewer cannot open) holds a Dropbox thread "Hi OpenAI, finish login with your Dropbox security
code" ("We noticed there was an attempt of signing in to your Dropbox account"), three messages, the
last at 15:59 UTC on 2026-09-30.

**The evidence suggests** Dropbox's risk engine challenged the reviewer's sign-in with an emailed
one-time code, which OpenAI's form forbids ("no MFA, SMS codes, email confirmation (including emailed
codes or magic links)"). That explains the first attempt directly; the second (16:03) is not tied to
a timestamped email. The funnel shape alone is not diagnostic: Brad's own cold test (2026-09-17 UTC,
09-18 NZ) shows "posted, no return" twice before a third trip connected. The fix bypasses every third-party
login, so it covers either reading.

That cold test ran from Brad's New Zealand network and was never challenged with a code. Dropbox
challenges on its own risk score, which we can neither reproduce nor switch off.

Ruled out by a code trace and live probes (2026-09-30 19:50 UTC, edu v113, same OAuth code as the
v112 that served the review): no OAuth-path file changed after the 2026-09-18 21:40 UTC submission;
the pinned ChatGPT client with both callbacks, S256 PKCE and every `resource` spelling reaches the
consent page; both provider POSTs 302 to the provider with our registered callback; chatgpt.com's
CIMD document still resolves from Fly. A client or redirect refusal records `mcp_authorize_refused`,
and a Cancel at Dropbox records `provider-denied`. Neither happened.

Same class as 1.0.0: OpenAI's 2026-09-23 appeal reply said their reviewer reached both the Dropbox
and the Google sign-in pages without credentials. Twice the reviewer stopped at a third party's login.

## 2. Root cause

Our only sign-in is somebody else's. A consumer login at Dropbox or Google may challenge any
unfamiliar sign-in, and a reviewer in a shared cloud browser is the most unfamiliar there is. Better
third-party credentials cannot fix that. OpenAI's guidance asks for "a login and password for a
fully featured demo account" that works "immediately without MFA approval, email or SMS codes".

## 3. Options considered

1. **Let the reviewer read the mailbox.** Rejected: emailed codes are named as forbidden, and the
   mailbox's own login can challenge in turn.
2. **Google Workspace reviewer (Variant A).** Rejected: Google challenges unusual sign-ins too; the
   admin override lasts ten minutes.
3. **Dropbox two-step verification.** Rejected: MFA is forbidden outright.
4. **A server-held demo record.** Rejected: a health record, even an invented one, on Brad's server.
5. **Recommended: a reviewer sign-in on our own consent screen**, for the ChatGPT client only. A
   username and password we issue connect the session to the reviewer's existing Dropbox record. The
   record stays in a Dropbox. The one change to our custody model is disclosed everywhere it is
   stated (§6): for this one invented account, the server holds the Dropbox refresh token.

## 4. Design

### 4.0 Prerequisite: Sentry must not carry request bodies (found in round 3)

`instrument.server.mjs` samples 20% of server transactions and scrubs only in `beforeSend`; there is
no `beforeSendTransaction`. `@sentry/core` 10.57 captures incoming request bodies by default and
attaches them to transactions. Reproduced locally (repo SDK, same config shape, a capturing
transport): a form POST to `/mcp/authorize` put `password=…` in the transaction's `request.data`, and
the Bearer header rode with it. The same path would send `/mcp` JSON-RPC bodies (health values) and
live one-hour bearer tokens. Whether Sentry stored them is unverified: the ~535 server "POST *"
transactions of the last 14 days show no body attribute in their span data. Fix FIRST, as its own
commit under US-09 AC7: `maxIncomingRequestBodySize: 'none'` (or `ignoreRequestBody`) on the http
integration, plus a `beforeSendTransaction` that runs `scrubServerEvent`, plus a transport-capture
test proving neither a body nor an Authorization header leaves. Then query Sentry for any stored
transaction with `request.data` and report what was found, and purge it if any exists.

### 4.1 Secrets (Fly `health-tool-edu`), all three valid or the feature is off

- `MCP_REVIEWER_USERNAME`: a plain lowercase word, no `@`.
- `MCP_REVIEWER_PASSWORD_SHA256`: 64 lowercase hex characters, SHA-256 of the NORMALISED password.
  The password is typeable in a remote browser that cannot paste: 26 characters from an unambiguous
  lowercase alphabet (no `l`, `1`, `o`, `0`; about 130 bits), shown in groups of four. Normalising
  before hashing (lowercase, spaces and dashes removed; the username trimmed and lowercased) forgives
  pasted spaces, grouping dashes and caps lock. No KDF: a 128-bit random secret needs none, and scrypt would hand an attacker a CPU
  lever on the libuv pool every provider fetch shares.
- `MCP_REVIEWER_DROPBOX_RT`: a Dropbox refresh token for the reviewer account, minted the way every
  live connection is (confidential code flow, same app, same app folder). Lasts until revoked.

`reviewerConfigured()` is true only when all three are present AND the hash is exactly 64 lowercase
hex characters AND the username has no `@`. A malformed secret switches the feature off rather than
throwing inside `timingSafeEqual` (which throws on unequal lengths).

### 4.2 The token never leaves the server; grants carry a generation

`rv` = first 16 hex characters of SHA-256 of `MCP_REVIEWER_PASSWORD_SHA256 ‖ MCP_REVIEWER_DROPBOX_RT`.
Changing the password OR the token therefore ends every reviewer session, so a leaked password is
answered by `--password` alone.

- `CodePayload`, `AccessPayload` and `RefreshPayload` gain an optional `rv`. `issueTokens` gains an
  `rv` parameter. A reviewer grant is sealed with `rv` set and `rt: ''` in all three blobs, at every
  step: the code minted at consent, and the access and refresh blobs `/token` issues.
- **`/token` never resolves.** For both grant types it checks `reviewerLive(rv)` (configured, and
  `rv` equals the current generation) and re-seals `{rv, rt: ''}`. A dead generation answers
  `invalid_grant` and counts `reviewer-generation`.
- **`/mcp` checks once, at the top.** Right after the access token is unpacked in `mcpEndpoint`
  (mcp.server.ts, before dispatch), a grant with `rv` that is not live answers `unauthorized()`, a
  401. That covers `initialize`, `tools/list`, `report_feedback` and every record tool, which the
  provider-refresh site alone would not.
- **The real token is read only where it is used**: one helper, `grantRefreshToken(token)`,
  returning the sealed `rt`, or the secret when `rv` is present; called at the one provider-refresh
  site (mcp.server.ts, ≈268).
- **Connection key**: `connectionKey()` today hashes `rt` at seven production sites (mcp.server.ts
  ≈227, 300, 363, 382, 464; mcp-import.server.ts ≈271; the key also feeds `githubFiler`). Its
  signature becomes `connectionKey(grant: { rt, rv? })`, so the compiler finds every site, and a
  propose and its confirm (≈363 and ≈382) can never disagree. For a reviewer grant it hashes
  `'reviewer:' + rv`, explicitly, so all reviewer sessions share one stated bucket (writes, tool-call
  rate, import files, feedback dedup, confirm receipts), per machine. §7 step 4 checks the listed
  test cases fit inside it with room for several reviewers.

So `fly secrets unset` or a rotated token kills every reviewer connection on its next request of
any kind. The Dropbox-side kill is revoking the token (§4.5).

### 4.3 Consent screen

- Rendered only when the sealed client id **equals exactly** `https://chatgpt.com/oauth/client.json`
  (chatgpt.com echoes any query string into a CIMD document, so `…client.json?x=1` resolves as a
  client named "ChatGPT"; name or host is never the gate), `reviewerConfigured()`, and Dropbox is
  available. Claude, Codex, other CIMD and DCR clients never see it. The gate decides who SEES the
  form; the password is the only security boundary.
- **Open, above the provider buttons**, headed "OpenAI app reviewers: sign in here", with one line:
  "For OpenAI's app review only. This is not your Dropbox or Google password." Username (`pattern`
  refusing `@`, `autocomplete="off"`), password, "Sign in". Below it, the existing choice under
  "Everyone else: choose where your record is kept".
- Posts to the existing `POST /mcp/authorize` with the sealed Dropbox state already on the page, plus
  `reviewer=1`, `username`, `password`. Nothing goes in a URL.
- **Wrong login re-renders the consent page** (fresh sealed states, same client and redirect) with an
  inline "That username or password is not right." Input is never echoed. The reviewer retries
  without restarting from ChatGPT.
- **A bare `GET /mcp/authorize`** (no `client_id`) renders a plain page, 200: "This page opens when
  you connect Health by Dr Brad from ChatGPT. Go back to ChatGPT and press Connect." No refusal row.
- The page's own custody sentences are corrected (§6).

### 4.4 Order in `consentGiven`

1. Unpack the sealed state as today (expiry, client and redirect binding). The Origin check already
   refuses cross-site POSTs before this.
2. If `reviewer=1`: require the exact pinned ChatGPT client id, `state.provider === 'dropbox'`,
   Dropbox available and `reviewerConfigured()`; else the existing error page.
3. Failures-only limiter, built on `createQuotaCounter` (`remaining` to check, `take` on a failure;
   `createRateLimiter` counts every call and cannot do this): 20 failures per IP per 15 minutes,
   per machine. A brute force against a 128-bit secret is infeasible anyway; the limiter only stops
   noise.
4. Normalise the submitted username and password (§4.1). Hash the configured username and the
   submitted one with SHA-256; hex-decode the stored password hash to 32 bytes and hash the
   submitted password; compare both pairs of 32-byte buffers with `timingSafeEqual`, always both,
   so a wrong username and a wrong password take the same path.
5. On success, mint the authorization code through one helper extracted from `providerCallback`
   (`mintClientCode(state, grant)`, shared, not duplicated), with `rv` set and `rt: ''`; 302 to the
   client's `redirect_uri` with `code`, `state`, `iss`. A wrong login's re-render restamps the
   state's 30-minute clock; harmless, since the state only ever mints codes for the original PKCE
   challenge, and noted beside `STATE_LIFETIME_SECONDS`.
6. `mcp_consent_posted` moves below the branch point and fires only on the provider branch.

Counters, value-free, each database write behind the existing `allowRateLimitEvent` brake where a
flood could drive it:
- `mcp_connect {client, provider: 'dropbox', via: 'reviewer'}`. `via` is owned by `mcp_connect`
  alone through `EVENT_KEY_OWNERS`. Unregistered, `cleanMetadata` would strip it silently (keeping
  the row, warning Sentry), so a test asserts the STORED metadata holds `via`.
- `mcp_connect_failed {client, reason}` with `reviewer-credentials`, `reviewer-rate-limited` and
  `reviewer-generation` added to `MCP_OAUTH_REASONS`. The credentials and rate-limited rows go
  through `allowRateLimitEvent`.
- Nothing logs the username, password or token. The POST body is never logged.

### 4.5 Minting, checking and revoking the token

A one-off script, `tools/mcp-reviewer-token.ts` (run with `npx tsx`), run by Brad. Separate modes, so a re-mint never
touches the password (and the password in the OpenAI form never goes stale mid-review):

- **`--password`**: generates the password (§4.1), shows it once, grouped, for Brad's credentials
  file and the OpenAI form, and stages only `MCP_REVIEWER_USERNAME` and
  `MCP_REVIEWER_PASSWORD_SHA256`. Running it again is the answer to a leaked password: it changes
  `rv` and ends every reviewer session.
- **Superseded 2026-10-02 (see the amendment below).** **`--mint --expect <account_id>`**: the confidential code flow with no redirect (Dropbox shows the
  code on screen), `token_access_type=offline`, exactly as live connections are minted, so the
  server's secret-bearing refresh is the proven path. Brad opens the URL in a **private window**,
  signs in as the reviewer (from home, where he can read any emailed code), presses Allow, and pastes
  the code at a hidden prompt; the app secret, from the Dropbox App Console, at a second hidden
  prompt (`.env` holds none). Before anything is stored: the `account_id` that `/oauth2/token`
  returns with the token (no extra scope needed; `get_current_account` would need
  `account_info.read`, which our scope list omits) must equal the expected id kept in Brad's private
  credentials file, and `health-roadmap.json` in the app folder must parse and match the known
  synthetic profile (born 1979, 178 cm, male). The script writes nothing to the record. On any
  mismatch it stages nothing and revokes the new token (`/2/auth/token/revoke` disables that refresh
  token and its access tokens, not the account's app link, so a mistaken run on Brad's real account
  leaves his own connections intact). It prints only "match" or "mismatch".
- **Amended 2026-10-02: identity by email, checked by machine.** Dropbox's UI never shows an
  account id, so Brad had no `--expect` value for the first mint. A first fix (print the id and
  ask "yes") was blocked in review: the synthetic-profile check also passes on the scratch
  microvitamin.com record, and an id Brad has never seen gives him nothing to judge. Now the mint
  asks for the reviewer account's email address at a visible prompt (not argv), requests
  `account_info.read` beside the live scopes for this mint only (Dropbox requires every
  user-linked app to register it, but a token carries it only when asked for), and calls
  `/2/users/get_current_account` after the exchange. It stages only if that `email` equals the
  typed address (trimmed, any case) with `email_verified` true, the `account_id` equals `--expect`
  when given, and the record is the synthetic profile; the record is read only after the account
  matches. `--expect` is now optional, and success prints the account id to save for it. The typed
  address must be a plus-address (the base address is the scratch account), refused before any
  Dropbox step. A failure prints `mismatch: <gate>` (never the account's email or name), awaits
  the revoke and prints "revoked" or "REVOKE FAILED"; a staging failure after a match also
  revokes and names the `flyctl secrets unset ... --stage` cleanup. The staged reviewer token now also carries `account_info.read`; nothing on
  the server uses it.
- **Staging** (both modes): `NAME=VALUE` lines on stdin to
  `flyctl secrets import --stage -a health-tool-edu` (verified with flyctl 0.4.6: reads stdin;
  `--stage` skips the deploy). Values never appear in arguments, output or files. They take effect
  on the next deploy. Deploy order is safe either way: code first leaves the feature off; secrets
  first are ignored by old code.
- **Check**: a small file shipped in the image, `tools/mcp-reviewer-check.mjs` (`COPY . .` already
  includes tools/), run INSIDE the machine where the secrets live, since Fly secrets cannot be read
  back: start the machine, then `fly ssh console -a health-tool-edu -C "node tools/mcp-reviewer-check.mjs"`.
  It refreshes with the same `client_id` + `client_secret` call the server makes and lists the app
  folder, printing only "ok" or "fail". Run before submitting and daily until the verdict.
- **No revoke mode** (cut in round 3): `fly secrets unset` kills every session at once (§4.2), and the
  reviewer account's own Dropbox connected-apps page revokes the token itself.

## 5. Story first: US-32 AC38 (into docs/user-stories.md, then regenerate the HTML)

AC38 (OpenAI's reviewer signs in on our page, added 2026-10-01): when the client is exactly the
pinned ChatGPT client and the three reviewer secrets are set and valid, an open "OpenAI app
reviewers" form sits above the provider choice. The right username and password connect that session
to the reviewer's synthetic Dropbox record with no third-party login. A wrong login re-renders the
page with one generic message and counts a failure; 20 failures per IP per 15 minutes are refused.
No other client, and no variant of the ChatGPT id, sees the form. Reviewer grants carry a
generation, never the token: unsetting or rotating the secret ends every reviewer connection on its
next request, whatever the request; so does changing the password. All reviewer sessions share one
stated connection bucket. A bare visit to `/mcp/authorize` (no client) shows a plain "start from
ChatGPT" page instead of an error.
Nothing logs the credentials. Brad's explicit exception, recorded in docs/mcp-architecture.md: this
is the one password login on the auth server and the one provider credential held server-side, both
for an invented account. The same AC amends the story's "our ONLY server-side revocation" line and
the Additive promise (docs/user-stories.md line 31) for that account. Usage signal:
`mcp_connect {via: 'reviewer'}` rows, expected only during OpenAI reviews.

## 6. Disclosure: every statement that would go false

One accurate sentence each, naming the one invented reviewer account:

- **The consent page itself** (app/routes/mcp.$.tsx): "Nothing is stored on our server" (≈line 577)
  and "our server unseals the cloud credential your assistant holds" (≈607-611).
- **docs/privacy-connector-addendum.md** (published page 133434343623, republish): "We hold the
  encryption key and never a copy of the credential", "no account", the list of what sits in a
  running server's memory (add the failure counter), the retention line (the connect row can carry
  `via`), and "nothing secret travels in a URL" (a provider's one-time sign-in code does, as OAuth
  requires, and it is useless without our app secret; §9.1).
- **docs/mcp-architecture.md**: the refresh token "sealed into the bearer token we issue" (≈23),
  split custody (≈33), key rotation as "our only server-side revocation" (≈49), the approved promise
  paragraph (≈57), "we hold no row to update" (≈186), "No accounts, no passwords" (≈314); plus the
  exception and a threat-model row (password leak: the password is the boundary, anyone can start
  the flow with the pinned id; token leak; the kill switch).
- **docs/agent-access.md** (≈291-293): "unseals the cloud credential your assistant holds".
- **docs/user-stories.md**: line 31's Additive promise and US-32's revocation line (through AC38).
- **docs/chatgpt-app-listing.md**: the Auth row ("The user authorizes their own Dropbox or Google
  Drive", ≈39), "We store nothing" (≈62), "over the user's own credential" (≈68).
- **docs/deploy-runbook-mcp.md**: the three secrets, the script, the check, the kill switch; and its
  own "we hold no row to update" (≈102) and "we collect and store nothing" (≈288).
- **docs/chatgpt-app-submission.source.ts and its generated .json** (the text OpenAI reads): "over
  that user's own credential" (four `open_world_justification`s), "fetches your file using your own
  credential" (≈195), "never stores your data on our servers" (≈223), "Nothing is stored on our
  servers" (≈26).
- **README.md** (≈38).
- **Published guides** (docs/guides, republished with `scripts/publish-guides.mjs`): command-line.md
  (≈158), connect-chatgpt.md (≈104), getting-started.md (≈45, 55), chatgpt-app.md (≈19, 121),
  connect-claude-desktop.md (≈109), and assets/three-ways.svg.

One rule decides each edit: a UNIVERSAL claim ("nothing is stored on our server", "no accounts, no
passwords") gains the one exception; a claim about YOUR credential stays, since it is still true for
every real user. Line numbers are approximate; the build greps each phrase, and the adversary on the
build greps again.

## 7. Tests (written first, cite US-32 AC38) and live verification

Unit and route tests:
- Form present for the exact pinned ChatGPT client with valid secrets and Dropbox available (fails
  today); absent for `…client.json?x=1`, Claude, Codex, other CIMD, DCR, a missing secret, and a
  malformed hash (these guard the positive one).
- Right login, with a normal non-hex username and the password pasted with spaces and in capitals:
  302 with a code; the code redeems at `/mcp/token` with PKCE; **unsealing the code, access and
  refresh blobs shows `rt === ''` and `rv` present in all three**; the bearer's `read_record` opens the
  reviewer record (Dropbox adapter mocked) through the secret's token.
- Wrong password, wrong username, `@` in username, empty fields: 200 consent page with the inline
  message, no code, a counter row, input not echoed; both comparisons always run.
- Failures-only limiter: 20 failures refuse the 21st; successes never count; the window expires; a
  second IP is unaffected.
- Two-phase tools on a reviewer bearer: `correct_value` propose then confirm, and `file_results`
  propose then commit, both succeed (they key the propose and the confirm separately today).
- `reviewer=1` refused for a Google state, a non-ChatGPT client, and a cross-origin POST (403).
- Kill switch: after the token secret is unset, after it changes, and after the password hash
  changes, a reviewer refresh grant gets
  `invalid_grant`, and `initialize`, `tools/list`, `report_feedback` and `read_record` each get 401.
- Connection key for reviewer grants is `hash('reviewer:' + rv)` and stable across sessions.
- Counter rows keep `via` through the strict schema; `via` is refused on any other event; the new
  reasons are accepted; `mcp_consent_posted` does not fire on a reviewer login.
- Bare `GET /mcp/authorize` renders the "start from ChatGPT" page, 200, with no refusal row (fails
  today: 400 plus an `unknown-client` row).
- A capturing Sentry transport during a reviewer login and during an `/mcp` tool call receives no
  request body, no Authorization header, no username, password or token (the §4.0 test).

Live, after deploy, before resubmitting:
1. `--check` prints ok (the real server-side refresh path, secret included).
2. A Playwright script acts as ChatGPT: exact pinned client id, **each** pinned callback in turn,
   real PKCE, our `resource`. Wrong password first (page re-renders), then right; capture the redirect
   to chatgpt.com without following it; redeem at `/mcp/token`; call `read_record` and `get_plan`
   only, so the fixture is untouched. Record the run's UTC window, since its funnel rows carry
   `client: chatgpt`.
3. Brad connects in ChatGPT developer mode with the reviewer login, end to end.
4. Fixture: every positive case must hold on a record other reviewers have already used.
   - Add a NEW ferritin row dated within the last few days through the normal write path (a
     correction keeps the original date and cannot extend a row's life), so positive 5 stays inside
     the 90-day window for the whole review.
   - Positive 1: relative expectations ("at least N measurements and lab results", "a ferritin
     result"), never exact counts.
   - Positive 2: a specific past date that is empty today, with the expected behaviour for a slot
     already filled stated (the tool refuses a second value on a day and offers a correction).
   - Positive 4: a synthetic lab PDF supplied with the listing, so no reviewer uploads a real
     person's report into a record whose credential our server holds; expected output covers a file
     already filed ("already imported") as well as a first import.
   - Positive 5: "My most recent ferritin should be 10 ug/L higher than it shows." The assistant
     reads the value, proposes, and corrects after the yes. Nothing invented.
   - Budget: the listed cases' cost against the shared bucket (60 weighted writes per hour, 120 calls
     per minute, 30 import files per day, 3 `report_feedback` issues per day per connection) with
     room for several reviewers; say in the instructions that the feedback case is limited per day.
   - Proof: run the full positive set TWICE in a row through the reviewer login (Playwright as
     ChatGPT, or ChatGPT developer mode), and both runs must pass as written.
5. Real WebKit screenshot of the consent page at phone width.

## 8. Submission

- `docs/chatgpt-app-listing.md` Test credentials, Variant C: "Connect Health by Dr Brad in ChatGPT.
  Our page opens with a box headed 'OpenAI app reviewers: sign in here'. Enter the username and
  password below and press Sign in. You return to ChatGPT connected. There is no Dropbox or Google
  sign-in, no code and no email. Please do not press Continue to Dropbox or Google Drive." Username,
  password. If a login URL is required, give `https://chatgpt.com` and the steps; never
  `/mcp/authorize` alone. Variants A and B stay as history.
- Version 1.0.2: `SERVER_VERSION` in mcp-tools.ts and its pin in mcp-rpc.test.ts. Release note:
  "Reviewer sign-in on our own consent screen, for the ChatGPT client only."
- Brad resubmits from the OpenAI Platform dashboard (Scan Tools first; re-select Healthcare).
- Reply to the rejection email, worded as evidence, not certainty: our logs show two attempts that
  reached Dropbox and did not return, and the account's mailbox shows Dropbox asked for an emailed
  code at 15:59 UTC; the new build signs reviewers in on our own page with no third-party login.

## 9. Separate work (found by the trace, not the cause)

1. **Request lines log full URLs.** `react-router-serve`'s logger writes `/mcp/callback?code=…&state=…`
   to Fly logs: a provider's single-use code (useless without our app secret) and our nonce (useless
   without the `__Host-` cookie). The privacy wording is corrected in this change (§6); the logger fix
   is a start-up change, filed as its own task right after this ships.
2. **Silent Origin 403s** record nothing. Left out of this change: a counter there runs before any
   limiter and would be an unthrottled database write. Revisit with the logger task.
3. **A per-connector ChatGPT callback** (`https://chatgpt.com/connector/oauth/{id}`) gets a dead-end
   400 today. We meet the conditions for the stable callback, and the reviewer used it. Left alone
   unless Brad wants the hardening.

Production LOC estimate for the build: +150 to +200 (reviewer branch, generation checks, form, bare
page, counters, copy corrections), minus the callback tail moved into the shared helper. Deletions
are confirmed at commit time. The script is a tool, outside production.

## 10. Residual risk

A reviewer who ignores the box and presses Continue to Dropbox meets the same challenge as before.
The box is on top, open, and named in the instructions; that is as far as we can push it without
removing Dropbox for everyone. Whether OpenAI objects to reviewer-only UI shown to every ChatGPT user
is unknown; their guidance asks for exactly this kind of demo login.

## 11. Review record

**Round 1 (v1).** Opus adversary R1–R15; Codex R1–R4.
- A1 token script unchecked account; `.env` has no app secret; `secrets set NAME=-` wrong → §4.5.
- A2 `fly secrets unset` not a kill switch (token sealed into 90-day blobs) → §4.2.
- A3 reviewer clicks first button; bare login URL errors; typo dead-ends → §4.3.
- A4 scrypt DoS lever → §4.1. A5 successes locked out a NAT → §4.4. A6 strict schema, reasons,
  consent counter, verification rows → §4.4, §7. A7 password field for every client → §4.3.
- A8 privacy statements go false → §6. A9 no liveness check → §4.5. A10 shared bucket, one-shot
  fixture, ageing row → §4.2, §7. A11 hedge the cause → §1, §8. A12 provider must be Dropbox → §4.4.
  A13 AC38, SERVER_VERSION, LOC, Codex, recorded exception → §5, §8. A14 URL wording → §6, §9.
  A15 more tests; phone-network check dropped → §7.
- Codex C1 AC38 text → §5. C2 custody exception → §3, §6. C3 `secrets import --stage -a
  health-tool-edu` → §4.5. C4 LOC → header.

**Round 2 (v2).** Opus adversary R1–R14 (verdict: do not build v2; fix the text); Codex R1–R3.
- A1 resolving at `issueTokens` would seal the real token into ChatGPT's blobs → §4.2 (`/token` never
  resolves; unseal test in §7).
- A2 + Codex R1 revocation missed `initialize`, `tools/list`, `report_feedback` → §4.2 (check at the
  top of `mcpEndpoint`).
- A3 connection key unstated → §4.2, §7 step 4. A4 `--check`/`--revoke` impossible from outside →
  §4.5 (in-machine). A5 PKCE token plus server secret unproven → §4.5 (confidential flow, as live).
  A6 re-mint changed the password → §4.5 (separate modes). A7 more false statements, including the
  consent page → §6. A8 unthrottled counters → §4.4, §9.2 dropped. A9 query-string echo → §4.3
  (exact id). A10 limiter helper, hash length → §4.1, §4.4. A11 `via` owner → §4.4. A12 + Codex R2
  a correction cannot re-date; one-shot case → §7 step 4. A13 timing and revoke scope unconfirmed →
  §1, §4.5. A14 a real lab PDF in the reviewer record → §7 step 4.
- Codex R3 LOC for this document → header.

**Round 3 (v3).** Opus adversary R1–R12 (verdict: BUILD WITH NAMED FIXES); Codex R1–R2.
- A1 Sentry transactions carry request bodies and Authorization headers → §4.0 prerequisite.
- A2 password not typeable in a no-paste remote browser → §4.1 alphabet, grouping, normalising.
- A3 password rotation revoked nothing → §4.2 `rv` covers both secrets.
- A4 + Codex R2 fixture breaks for the second reviewer; "a value you choose" invents data → §7
  step 4 (every case holds on a used record; run twice).
- A5 two-phase paths untested; wrong count of refresh sites → §4.2 typed `connectionKey`, §7.
- A6 more false statements (submission JSON, README, guides, runbook) → §6 and its one rule.
- A7 `get_current_account` needs a scope we do not ask for → §4.5 uses the token response's id.
- A8 harmful mismatch advice; revoke scope answered → §4.5. A9 `node -e` over ssh fragile → shipped
  check file; revoke mode cut. A10 text errors → §4.4. A11 cold-test wording → §1. A12 AC38 bare
  GET, limiter expiry, state restamp, feedback cap → §5, §7, §4.4.
- Codex R1 plaintext username compared as a hash → §4.4 step 4.

## 12. Decisions for Brad

1. **The exception.** A password login on the auth server, and a Dropbox token held server-side,
   both for the invented reviewer account only, ChatGPT client only. Without it, the reviewer's only
   door is a third-party login we cannot stop from challenging them.
2. **Keep it after approval?** OpenAI reviews every update, so the recommendation is yes; or unset the
   secrets between reviews (one command, instant kill).
3. **The box is visible to every ChatGPT user**, open and above the choice. Recommended: the reviewer
   pressed the first button within 1.4 to 3 seconds, and a hidden box risks a third rejection.
4. **The Sentry fix (§4.0) goes first**, whatever you decide on 1 to 3: it is a privacy fix in its
   own right.
5. **Your part**, about 15 minutes: fetch the Dropbox app secret from the App Console and run the
   script's `--password` and `--mint` modes from a private window at home; later, connect once in
   ChatGPT developer mode; then resubmit.

## 13. Brad's decisions (2026-10-02)

1. **Exception: yes.** The reviewer login and the server-held reviewer Dropbox token, ChatGPT client
   only, invented account only.
2. **Box open, above the choice, while a review is pending: yes.**
3. **Hidden between reviews.** The box appears only while the three reviewer secrets are set (§4.1),
   so after OpenAI approves, `flyctl secrets unset -a health-tool-edu MCP_REVIEWER_USERNAME
   MCP_REVIEWER_PASSWORD_SHA256 MCP_REVIEWER_DROPBOX_RT` restores today's consent page for everyone,
   with no code change, and ends every reviewer session (§4.2). Before each later submission, stage
   them again (`--password` keeps the old password only if Brad re-enters it; otherwise the form gets
   the new one). The runbook states both steps.
4. Stored Sentry IPs: left to Sentry's retention. Codex reviewer is now `gpt-6.1-sol`.
