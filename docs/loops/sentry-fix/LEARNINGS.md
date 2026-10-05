# sentry-fix — learnings index

(Constitution rules apply: ≤200 lines/25KB, dedup by tag+subsystem — update in
place, depth goes to `notes/<slug>.md`, raw pulls stay worker-local.)

## Triage priors (seeded from the repo's known noise, 2026-08-10)

- `[noise][server]` Dev-mode react-router frames in server stacks are EXPECTED
  residue, not a bug signal — react-router-serve runs the dev build in prod
  (see memory/project_react_router_serve_dev_build.md). Don't chase.
- `[noise][widget]` Foreign-origin errors: drstanfield.com runs Horizon —
  errors with frames only in theme assets are not ours; same for injected
  scripts (in-app-browser/TV-browser overlays) in either shape:
  native-frames-only unhandled rejections, or onerror with a single
  `<anonymous>` frame (our bundles always load from real CDN URLs). When the
  minified symbol/pattern greps to nothing in our bundles — ledger-on-sight
  (08-25 Ba`prod; 09-03 Ka`prod; 09-04 n.data.split, Tizen TV; 09-10
  `window.webkit.messageHandlers` in `unload`, GSA's WKWebView; 09-20 zaloJSV2).
- `[prior][widget]` iOS WebKit-only layout/interaction bugs are a known class
  (CLAUDE.md list: content-box flex default, 280px input min-content, sticky
  in max-content parents). If a fix touches layout, the escape analysis should
  ask "would tools/webkit-verify have caught this?"
- `[prior][process]` Three blanket rewrites (chat-health, 2026-08-07) all
  regressed retrieval: fix ONE issue at a time, measure, never batch-fix.

## Run learnings

- `[class][widget]` 2026-08-12 — A 5xx whose body isn't our handler's JSON is
  the proxy/edge answering (machine restart / cold start), not an application
  answer; client code must not treat it as final. Fixed for chat via one-shot
  retry (US-15 AC3, PR #11); same class likely reachable on the other
  `PROXY_PATH` endpoints — extend only on Sentry evidence. Residuals, not
  defects: a retry can duplicate the user row or cost one extra LLM spend.
- `[expected][sentry]` 2026-08-12 — The info-level issue titled
  "Chat transient upstream 5xx, retrying once" IS the retry instrumentation
  from PR #11 — ledger it `wontfix` (expected) on first appearance; its rate
  is the transient-failure trend, worth reading, never "fixing". Same on
  sight for self-generated probes (`level=info` + a non-production
  `environment` tag; ids: docs/sentry-filter-verification-2026-09-07.md).
- `[process][review]` 2026-08-12 — Verify a safety claim at the CALL SITE
  that enforces it, not the helper that implements it (round-1 REJECT: dedup
  helper was sound, but the route gates it behind `if (conversationId)`).
- `[gotcha][sentry-api]` 2026-08-12 — Issues-list `count` is LIFETIME and
  `statsPeriod` shapes only `stats` (''/24h/14d): rank by summing buckets,
  test newness by `lastSeen` vs the ledger. Only the latest event per issue
  is retained — event-history pulls return 1 row.
- `[noise][server]` 2026-08-12 — youtube-bot `logTickError` (handled=yes,
  tag `feature=youtube-bot`) relays upstream Google failures as the exception
  value: OAuth 500s, Cloudflare HTML pages, and (confirmed again 2026-09-08) a
  Data API 503 from `listReplies` in the follow-up pass. Catch topology: the
  per-thread loops catch and `continue`; token refresh and the top-level list
  abort the whole tick; a `processFollowUps` throw drops the rest of that pass.
  Every direction is no-post and the next tick re-scans, so a single event is
  transient upstream → `wontfix` on sight. Grouping: HTML-page bodies once
  split one cause into two issues; the API paths now truncate to 200-300
  chars. Worth a look only on several events in one day, if the caught value
  feeds a cap or lock decision (PGRST303 entry), or if it is the sticky
  `resolveHandle` null (one failure disables @handle addressing until restart).
- `[class][widget]` 2026-08-14 — Any DESIGNED "log it and carry on" failure
  path is a silent-data-at-risk candidate: cloud persist failures were
  memory-only by design, so no test could flag the loss (US-09 had no AC).
  Fixed for the roadmap file via marker-gated on-device mirror (PR #19);
  chat-history shares the machinery unmirrored (declared best-effort — flip
  needs a product call). The PR #11 transient-upstream class confirmed again
  in cross-origin form: an edge 5xx without CORS headers surfaces as an
  immediate fetch REJECTION, not a status code.
- `[defect][widget]` 2026-08-14 — `standalone/connect.ts` migrateLocalInto /
  copyDownToDevice were type-broken and silently no-oped (US-09 AC3 dead in
  source, no Sentry signal — silence was the symptom). Fixed same day on
  Brad's authorization (`connect-migrate.test.ts`); both tsconfigs burned down
  36→0 and gated in ci.yml, which surfaced a second latent crash (Object.hasOwn
  on iOS WebKit <15.4 → hasOwnProperty.call, floors kept at ES2020). app/ is
  still ungated — a standing task.
- `[noise][server]` 2026-08-23, sharpened 10-05 — Probes surface as handled
  server errors. OAuth open-redirect/XSS payloads (`/auth/exit-iframe?exitIframe=
  javascript:…`) give "Invalid URL. Refusing to redirect": `sanitizeRedirectUrl`
  firing. Route misses give `getInternalRouterError` "No route matches URL"
  (handleError captures every 404; 6X = operator curls to /health). Ledger
  `wontfix` on sight; both paths are grant-excluded, so hygiene is propose-only.
- `[gap][sentry]` 2026-09-07, closed 09-08 — Until Brad's PR #73 (live from
  deploy run 58, 09-08 20:59Z) production `allowUrls` named the retired
  `health-tool.js`, so the SDK dropped every main-bundle exception: widget
  "no-op" days before 09-08 are lower bounds, and issues first seen soon
  after are newly VISIBLE, not old (6G's events were fresh connects), so rank
  by `stats` since 09-08. Only the side bundles define `__SENTRY_RELEASE__`
  (vite.config.chatbot/site-chat/upload): a `release` tag means a side
  bundle, its absence health-plan-v2 — grep the right asset. Storage
  adapters put document refs (date + sanitized title) into thrown messages:
  READ TITLES before pasting them into a report or ledger note (AC7's text
  scrub catches values, not titles).
- `[class][widget]` 2026-09-17, root-fixed 2026-09-20 — Anything `main()`
  awaits before `createRoot` is a blank-widget path: an unhandled rejection
  there leaves the mount empty and the user reloads (1-4 loads per session in
  6G/6K). The Drive case: Google's granular consent lets the Drive box stay
  unticked, the grant carries openid+email only, tokens exist and refresh, so
  `isConnected()` passes and every lookup answers 403 (three browsers, 09-10,
  09-15, 09-20, each a fresh consent). Net: `startOnBackend` (US-09 AC13,
  PR #106). Root: Google NAMES the granted scopes — `scope=` on the redirect
  URL beside `code`/`state`, and `scope` in the popup token response — so the
  grant is refused before any token is kept (US-09 AC15). Rule: before adding
  a probe request to learn a fact, check whether the provider already handed
  it over (URL params, token-response fields); the /simplify altitude pass
  found this after a first draft probed Drive and special-cased 401/403. Still
  true for any OTHER 403: `liftLocalInto` swallows it and
  `cloud_connect_success` fires (a refused grant counts as a success). Closed 09-24 (6T, US-09 AC16, PR #121): the
  remembered-backend key now goes through the safe accessors on every path;
  a "nothing will be kept" notice is still owed. Reading tells: a same-second PAIR (handled `cloud-connect
  op=migrate-up` + a second capture) is one page load; an exchange POST plus a
  `navigation` crumb before it is a fresh consent, not a refresh.
- `[class][widget]` 2026-09-24 — Storage-blocked browsers come in three shapes
  and the field sent all three inside ten days: `localStorage` missing (Safari
  26.6, ReferenceError), the getter throwing SecurityError (Chrome Mobile),
  the property `null` (old WebView). One bare read on the path `main()` awaits
  is a blank widget for every shape; `lib/storage.ts`' safe accessors already
  covered them, and the remembered-backend key was the one caller that
  bypassed them (6T/6N/6J, US-09 AC16, PR #121). Escape: every standalone test stubs a
  WORKING localStorage. Audit shortcut: `grep -rn "localStorage\." widget-src
  --include=*.ts* | grep -v test` — anything outside lib/storage.ts and a
  try/catch is this class again. A scrub keeping only closed tags can still
  carry the error NAME value-free (`cause`): 6M sat unreadable at 32 events
  without it, and 6W (10-02, upload `no_files`) repeats the gap.
- `[class][widget]` 2026-10-02 — Bundled DEPENDENCIES escape our ES2020 floor:
  tsc checks our source only, and pdfjs-dist 4.9 ships 41 bare
  `Promise.withResolvers` calls (ES2024) in health-upload.js, so every PDF fails
  on Safari <17.4 (adversary find, not yet tied to an event). Audit: grep built
  `assets/*.js` for post-floor APIs (`withResolvers`, `Object.groupBy`,
  `Array.prototype.findLast`, `structuredClone`) before trusting a floor.
- `[defect][widget][merge]` 2026-09-18 — The 09-17 fallback (PR #106) ran the
  session on the device copy at `eraseEpoch` 0; `mergeFiles` hands a higher
  epoch the whole file, so the next good load of a once-erased record silently
  dropped every fallback edit, and the marker cleared on that same save. Drive
  had it already; the fix widened it to every provider. Fixed outside the
  loop's grant (merge.ts is health-core): the pending marker holds the last
  in-step moment and never advances while pending; `mergeFiles` takes
  `keepNewerThan`, pruning the device file to rows at or after it and
  re-merging those as ordinary rows, as copy-down on a provider switch now does
  too; Dropbox/GitHub/WebDAV get "could not be reached, Retry", not the guest
  pitch (US-09 AC14). Residual: no `erasedAt`, so a faster clock's row can
  outlive a later erase. Lesson: a fix changing WHICH FILE a session runs on
  must be checked against the merge that brings it back (eraseEpoch, LWW,
  marker timing); a guest view for a signed-in user is a fork, not a fallback,
  and our tests proved only the fallback.
- `[gotcha][supabase]` 2026-09-24 — `SUPABASE_PRODUCT_HEALTH_KEY` is a Bearer
  JWT, not an API key: send `apikey: $SUPABASE_ANON_KEY` (a publishable key)
  + `Authorization: Bearer $SUPABASE_PRODUCT_HEALTH_KEY` (role
  `product_health_ro`, valid to 2027-08-07; the product-health charter has
  the recipe). The JWT in `apikey` answers 401 "Invalid API key": every
  "key rejected" gap this loop reported (08-28, 09-17, 09-20) was that
  misuse, not a dead key. Funnel column: `event_name`. The role reads
  product_events, ab_events, feedback, chat_* and reminder_optin_v2 (emails):
  counts and event names only into a public report, never rows.
- `[gotcha][process]` 2026-08-14 — Clones are SHALLOW: `git log -S`/`--stat`
  blame graft-boundary commits (whole-tree adds); `git fetch --deepen=400`.
  Live-bundle proof without CDN access: the event's debug-meta debug id,
  grepped in committed `assets/` (10-02: edu-96 = 73291a90).
- `[class][server]` 2026-09-10 — Shopify's `appProxy` rejects an unsigned
  request by THROWING a 400 Response, and react-router returns a thrown
  Response as-is without `handleError`, so a route catch-all that captures it
  turns the framework's silent 400 into a Sentry error + 500 (PR #99, US-15
  AC9: rethrow `instanceof Response`). Audit: `appProxy` called INSIDE a `try`
  (only chat was). Triage: a fixed-message capture ("Chat: Action failed")
  pools unrelated causes under one id — a bare Fly host, empty query string
  and curl UA is an unsigned probe, not a widget turn.
- `[defect][server][platform]` 2026-08-27 — Supabase `PGRST303 "JWT issued at
  future"` hit ~1/3 of requests from one Fly machine starting 08-26 with NO
  deploy on our side. A legacy-style JWT (fixed old iat, e.g. the
  product-health key) never failed in 25 probes while the failing paths use
  the service key — with new-format `sb_*` keys the gateway mints a
  per-request JWT whose iat can outrun the project's PostgREST clock, so
  intermittent PGRST303 is platform-side: check the key format before hunting
  our code (confirmed again 2026-08-28, escalated to ~40% of half-hourly bot ticks; deploys
  regroup the continuing fault under NEW Sentry issue ids — check the ledger
  for the class before triaging an id as new). The defect class it exposed,
  now fixed twice (PR #30/US-27 caps; PR #35/US-28 cron locks): a "handled"
  degradation value (0 / empty map / false) feeding a SAFETY or SCHEDULING
  decision is fail-open — such reads must fail distinguishably (throw), never
  resolve to a value that also has a legitimate meaning ("nothing counted",
  "another machine won"). Audit shortcut: grep `return false` / `return 0` /
  `return {}` inside catch/error branches of anything a cron or cap gate calls.
