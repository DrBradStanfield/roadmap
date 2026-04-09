# Plan: Homepage Pivot — Roadmap Widget as Homepage Hero

## Context

The homepage currently functions as a supplement sales page. The Health Roadmap tool — Brad's main differentiator and lead capture device — is buried behind a tiny parenthetical link. This pivot makes the Roadmap widget the homepage's centerpiece, with a new lightweight email capture flow that doesn't require Shopify account creation.

**Stage 1** (this document's original scope) covers widget code changes: mobile 2-tab layout, guest email capture, Klaviyo integration, post-email flow.

**Stage 2** (appended below) covers the hero section and A/B testing system: hero image + heading built into the app block, A/B test management dashboard, conversion tracking with statistical significance.

Brad handles the Shopify theme changes separately: placing the app block on the homepage, removing the old hero/Klaviyo form, navigation restructuring, `/pages/roadmap` redirect.

### Default homepage text

- **Heading**: "Get Your Personalized Health Plan"
- **Subheading**: "Enter your health information below to receive personalized suggestions to discuss with your healthcare provider. The more information you provide, the more tailored your suggestions will be."
- The widget replaces the 3 Pillars section and "As a Family Medicine Doctor..." intro text

## Changes Overview

1. **Mobile: Simplify to 2 tabs** (Input | Plan) with CSS scroll-snap swipe
2. **Email capture: Stateless guest report** — inline email field replaces account-creation banner
3. **Klaviyo integration** — subscribe guest emails directly (no Supabase guest profiles)
4. **Post-email flow** — success → account creation prompt → latest 3 blog posts

---

## Design Decisions & Rationale

### Why no guest Supabase profiles?

The original plan created guest profiles in Supabase to store health data server-side before sending the report. This was rejected because:

1. **New auth path**: The entire backend assumes Shopify HMAC → `getOrCreateSupabaseUser()` with a `shopify_customer_id`. Guests don't have one. Creating a second auth path (service-key writes, guest tokens) adds permanent complexity for a transient need.
2. **Account merge is a landmine**: `sync-embed.liquid` has multiple "NEVER modify" invariants in CLAUDE.md. Adding guest→authenticated data migration touches this critical code path.
3. **It's unnecessary**: The guest already has all their health data in localStorage. The backend can receive it in the POST body, run calculations, generate the report, send the email, and return — all stateless. When the guest later creates an account, sync-embed already pushes localStorage to Supabase. Zero new merge logic.
4. **No session token needed**: Without a guest profile, there's nothing to merge, so no token to track.

### Why Klaviyo directly instead of Supabase?

Klaviyo is already integrated with Brad's Shopify store for email marketing. Storing guest emails in Supabase would create a second source of truth for email lists and require building export/sync tooling. Klaviyo's API accepts a profile + list subscription in one call. The email is captured where it will actually be used (marketing campaigns).

### Why reuse `api.measurements.ts` instead of a separate route?

The original plan proposed a dedicated `api.guest-report.ts`. This was rejected because:

1. **Duplicated infrastructure**: HMAC verification, rate limiting patterns, error handling, Sentry integration — all already exist in `api.measurements.ts`.
2. **No new app proxy entry needed**: The existing `/api/measurements` proxy path works. One less thing to configure and maintain.
3. **Clean integration**: The guest report is just another POST body branch (like `sendReportEmail`, `migrateGuestChat`, `sendWelcomeEmail`). The only difference is it's checked **before** the `customerId` auth gate, since guests don't have one.

### Why Swiper instead of CSS scroll-snap?

Initially planned as CSS scroll-snap (~10 lines of CSS), but Swiper was chosen during implementation because the two tabs have very different heights — the Input tab grows as progressive disclosure reveals sections, while the Plan tab length depends on suggestion count. Swiper's `autoHeight` handles this automatically, whereas CSS scroll-snap would require manual height management via JS. The tradeoff is ~40KB of bundle size for significantly simpler height behavior.

### Why blog posts after email (not supplements)?

Immediately pushing a sales page after someone trusts you with their health data undermines the goodwill you just built. The latest 3 blog posts keep the user engaged with valuable content (which is Brad's actual differentiator), and the supplements page is already linked in the email report and site navigation. Blog posts also give the user a reason to stay on the site rather than bounce.

---

## 1. Mobile: Two-Tab Layout with Swipe

### Current state
`MobileTabBar.tsx` has 8 tabs: `profile | vitals | blood-tests | medications | screening | supplements | results | chat`

Progressive disclosure gates tab visibility per `formStage`. Auto-navigation switches to results when suggestions first appear.

### New state
Two tabs only:
- **Input** (left) — All input fields in a single scrollable panel (same as desktop left column)
- **Plan** (right) — Results, suggestions, chat (same as desktop right column)

### Swipe implementation (Swiper)

Uses the [Swiper](https://swiperjs.com/) library (`swiper` package) for the two-tab swipe. Originally planned as pure CSS scroll-snap, but Swiper was chosen for:
- **`autoHeight`**: Automatically adjusts slide container height as form sections expand/collapse via progressive disclosure
- **Better swipe physics**: Native-feeling touch handling across all browsers without manual tuning
- **Simpler tab sync**: `onSlideChange` callback replaces `scrollend` event listener + manual index calculation

Tab bar highlight syncs via Swiper's `onSlideChange`. Tapping a tab calls `swiperRef.current.slideTo(index)`.

### Floating CTA

- On **Input tab**: floating "View Your Plan" button at bottom. **Only visible when `formStage >= 2`** (sex + height entered). Tapping scrolls to Plan tab. This creates a natural pull to see results as users enter data.
- On **Plan tab** (guest only): floating email capture bar at bottom (see section 3).
- Logged-in users on Plan tab: floating "Email My Plan" button (existing functionality, relocated).

### Changes

**`MobileTabBar.tsx`:**
- Simplify `TabId` to `'input' | 'plan'`
- Two tab buttons, active state synced to scroll position
- Remove 8-tab navigation, prev/next arrows

**`HealthTool.tsx`:**
- Mobile layout: horizontal scroll container with two panes
- Input pane renders all `InputPanel` sections (progressive disclosure still gates which sections are visible within the pane)
- Plan pane renders `ResultsPanel` + chat
- Remove per-section tab gating logic (replaced by within-pane progressive disclosure)
- Keep auto-navigation: when suggestions first appear, auto-scroll to Plan tab

**`styles.css`:**
- `.mobile-tab-content` scroll-snap container
- Floating CTA bar styles (fixed bottom, above tab bar)
- Hide floating "View Your Plan" CTA when `formStage < 2` (via data attribute or class)

### Files to modify
- `widget-src/src/components/MobileTabBar.tsx`
- `widget-src/src/components/HealthTool.tsx`
- `widget-src/src/styles.css`

---

## 2. Email Capture: Stateless Guest Report

### Architecture — maximum code reuse

The existing report email flow in `email.server.ts` has three steps:

```
generateReportHtml(userId, client)
  1. loadHealthData(client)                     ← Supabase-specific
  2. calculateHealthResults(inputs, ...)        ← PURE (no DB dependency)
  3. buildWelcomeEmailHtml(inputs, results, ...)← PURE (no DB dependency)
```

Steps 2-3 are pure functions with no Supabase dependency. The refactor: **extract steps 2-3 into a shared `buildReportHtml()` function** that both the authenticated and guest paths call.

```typescript
// NEW: Pure function — no Supabase, no side effects
// Extracted from the existing code in generateReportHtml() lines 142-152
export function buildReportHtml(
  inputs: HealthInputs,
  medInputs?: MedicationInputs,
  screenInputs?: ScreeningInputs,
  firstName?: string | null,
): { html: string } | { error: string } {
  if (!inputs.heightCm || !inputs.sex) {
    return { error: 'Insufficient data (need height + sex)' };
  }
  const unitSystem: UnitSystem = inputs.unitSystem || 'si';
  const results = calculateHealthResults(inputs, unitSystem, medInputs, screenInputs);
  const html = buildWelcomeEmailHtml(inputs, results, results.suggestions, unitSystem, firstName ?? null, medInputs, results.age);
  return { html };
}

// REFACTORED: Now delegates to buildReportHtml (was 20 lines, now 8)
export async function generateReportHtml(
  _userId: string,
  client: SupabaseClient,
): Promise<{ html: string; email: string } | { error: string }> {
  const data = await loadHealthData(client);
  if (!data) return { error: 'Profile not found' };
  const result = buildReportHtml(data.inputs, data.medInputs, data.screenInputs, data.profile.first_name);
  if ('error' in result) return result;
  return { html: result.html, email: data.profile.email };
}
```

**What this achieves**:
- `generateReportHtml()` (authenticated path) is refactored to use `buildReportHtml()` — same behavior, less code
- `checkAndSendWelcomeEmail()` can also be refactored to use `buildReportHtml()` — eliminates the duplicated calculate+build logic on line 95-100
- Guest report handler calls `buildReportHtml()` directly with POST body data
- **Zero new calculation or HTML logic** — it's the same code path for all three callers
- `calculateHealthResults()` already handles `undefined` medications/screenings gracefully (optional chaining throughout)

### No new Zod schemas for medications/screenings

The plan does **not** create new Zod schemas for `MedicationInputs` or `ScreeningInputs`. Here's why this is safe:

1. **`healthInputSchema` validates the required fields** — `heightCm` (number, 50-250) and `sex` ('male'|'female') are strictly validated. This is the data that determines the core report.
2. **Medications and screenings are optional pass-through** — `calculateHealthResults()` accepts `medications?: MedicationInputs` and `screenings?: ScreeningInputs`. If undefined or malformed, it defaults to no medications/no screenings. The function uses optional chaining (`medications?.statin?.drugName`) throughout — it cannot crash from bad input shapes.
3. **No database writes** — malformed medication data can't corrupt anything because the guest flow is completely stateless. The worst case is an email with missing medication-specific suggestions, which is the same as not entering medications.
4. **The email field is the only truly new validation** — `z.string().email()` in the handler.

### Fixup: HTML escaping in email template (pre-existing vulnerability)

`buildWelcomeEmailHtml` and its helper functions (`metricRow`, `metricRowWithRange`, greeting line) interpolate values directly into HTML with no escaping. This is a **pre-existing issue** — authenticated users' medication names flow through the same unescaped path. But it matters more for the guest flow because medications come from the POST body rather than Supabase (where they were validated on write).

**Fix**: Add an `escapeHtml()` utility in `email.server.ts` and use it in:
- `metricRow()` / `metricRowWithRange()` — escape `label` and `value` params
- `greeting` line — escape `firstName`
- Any other user-provided strings interpolated into HTML

This is ~5 lines for the utility + find-replace at interpolation sites. Fix applies to all email paths (welcome, report, guest), not just the new guest flow.

### Integration into `api.measurements.ts`

The guest report handler is added **before** the `customerId` check in the `action()` function:

```typescript
export async function action({ request }: ActionFunctionArgs) {
  await authenticate.public.appProxy(request);
  const body = await request.json();

  // Guest report — no auth required (checked before customerId gate)
  if (body.guestReport) {
    return handleGuestReport(body.guestReport);
  }

  // Existing auth flow continues unchanged below...
  const customerId = getCustomerId(request);
  if (!customerId) {
    return json({ success: false, error: 'Not logged in' }, { status: 401 });
  }
  // ... rest of existing handlers unchanged
}
```

**`handleGuestReport()` — private function in same file (~30 lines):**

```typescript
async function handleGuestReport(data: unknown) {
  // 1. Validate email
  const email = z.string().email().max(254).safeParse((data as any)?.email);
  if (!email.success) {
    return json({ success: false, error: 'Invalid email' }, { status: 400 });
  }

  // 2. Rate limit by email (reuses existing pattern)
  if (!checkGuestReportLimit(email.data.toLowerCase())) {
    return json({ success: false, error: 'Email limit reached. Try again tomorrow.' }, { status: 429 });
  }

  // 3. Validate health inputs (reuses existing healthInputSchema)
  const inputs = healthInputSchema.safeParse((data as any)?.inputs);
  if (!inputs.success) {
    return json({ success: false, error: 'Invalid health data' }, { status: 400 });
  }

  // 4. Build report HTML (reuses the new shared function — same code path as authenticated)
  const medications = (data as any)?.medications as MedicationInputs | undefined;
  const screenings = (data as any)?.screenings as ScreeningInputs | undefined;
  const result = buildReportHtml(inputs.data as HealthInputs, medications, screenings);
  if ('error' in result) {
    return json({ success: false, error: result.error }, { status: 400 });
  }

  // 5. Send email via Resend (reuses existing Resend client from email.server.ts)
  await sendEmail(email.data, 'Your Personalized Health Plan', result.html);

  // 6. Subscribe to Klaviyo (fire-and-forget)
  subscribeToKlaviyo(email.data).catch(() => {});

  return json({ success: true });
}
```

**What's reused vs new:**

| Component | Source | Status |
|-----------|--------|--------|
| HMAC verification | `authenticate.public.appProxy()` | Reused as-is |
| Email validation | `z.string().email()` from Zod | Reused (1 line) |
| Health input validation | `healthInputSchema` | Reused as-is |
| Medication/screening validation | `calculateHealthResults()` graceful handling | Reused (no schema needed) |
| Report calculation | `calculateHealthResults()` | Reused via `buildReportHtml()` |
| HTML generation | `buildWelcomeEmailHtml()` | Reused via `buildReportHtml()` |
| Email sending | Resend client + `resend.emails.send()` | Reused (extract `sendEmail()` helper) |
| Rate limiting pattern | Same `Map<string, {count, resetAt}>` | Pattern reused, new instance keyed by email |
| Error handling | Sentry integration | Reused |
| Klaviyo subscription | — | **New** (~20 lines in `klaviyo.server.ts`) |
| `buildReportHtml()` | Extracted from `generateReportHtml()` | **Refactor** (not new logic) |

### Resend `sendEmail()` helper

Currently `resend.emails.send()` is called inline in 3 places (`checkAndSendWelcomeEmail`, `sendReportEmail`, and soon the guest handler). Extract a small helper in `email.server.ts`:

```typescript
export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  if (!resend) throw new Error('Email service not configured');
  await resend.emails.send({
    from: `Dr Brad Stanfield <${RESEND_FROM_EMAIL}>`,
    to,
    subject,
    html,
  });
}
```

Then all three callers use `sendEmail()`. The existing `sendReportEmail()` and `checkAndSendWelcomeEmail()` are refactored to use it. Less duplication, same behavior.

### Exact UI copy

**Email field:**
- Placeholder: `"Email"`
- Button: `"Get Your Personalized Plan"`
- Button while sending: `"Sending..."`
- Button after success: `"Sent!"`

**Email subject line**: "Your Personalized Health Plan"

**Desktop layout**: email input field on the left, "Get Your Personalized Plan" button on the right — inline, single row. Replaces the current green guest CTA banner at top of results panel.

**Mobile layout**: same inline layout, floating at the bottom of the Plan tab.

### Email field UX

- `<input type="email" placeholder="Email">` with HTML5 validation
- Client-side regex check before POST: `/^[^\s@]+@[^\s@]+\.[^\s@]+$/`
- Inline error message below field for invalid format (no server round-trip)
- Button disabled while sending (prevents double-submit)
- Server-side Zod `z.string().email()` validation as defense in depth

### Rate limiting strategy

New in-memory rate limiter (`checkGuestReportLimit`) keyed by **email address** (normalized to lowercase), same pattern as existing `checkReportLimit`:
- **5 reports per email per 24 hours**
- `Map<string, { count: number; resetAt: number }>` with cleanup on the same `setInterval` as existing maps

Why email-only (no IP limit):
- IP extraction through Shopify app proxy is unreliable (forwarded headers can be spoofed)
- Email-based limiting is sufficient — an attacker would need unique valid email addresses to abuse
- The real cost is Resend API calls, and those are already rate-limited by Resend's plan limits
- If abuse becomes a problem, add IP limiting later (YAGNI)

### Klaviyo integration

**New file: `app/lib/klaviyo.server.ts`** (~20 lines)

```typescript
const KLAVIYO_API_KEY = process.env.KLAVIYO_API_KEY;
const KLAVIYO_LIST_ID = process.env.KLAVIYO_LIST_ID;

export async function subscribeToKlaviyo(email: string): Promise<void> {
  if (!KLAVIYO_API_KEY || !KLAVIYO_LIST_ID) return;
  // POST to Klaviyo v3 Subscribe Profiles API
  // Single HTTP fetch call, no SDK needed
  // Tag: "roadmap-guest"
}
```

**Required env vars:**
- `KLAVIYO_API_KEY` — already in `.env`
- `KLAVIYO_LIST_ID` — Brad needs to create a "Roadmap Guests" list in Klaviyo and provide the list ID

### Security considerations

- **HMAC verification**: All requests go through Shopify app proxy → `authenticate.public.appProxy(request)` ensures only storefront requests are accepted
- **No customer ID required**: The guest report branch explicitly allows unauthenticated requests. This is safe because: no data is persisted, no account is created, no Supabase writes. The only side effects are a transient email and a Klaviyo subscription.
- **Input validation via existing schemas**: `healthInputSchema` validates all health inputs with ranges, types, and constraints. Same validation as all other health data in the system.
- **Medications/screenings are safe to pass through**: `calculateHealthResults()` uses optional chaining throughout and cannot crash from malformed input. No database writes means no corruption risk.
- **Email not stored in Supabase**: Only sent to Resend (transient) and Klaviyo (marketing list). No PII stored in our database for guests.
- **No health data in Klaviyo**: Only the email address is sent to Klaviyo. Health data stays in the transient request only.
- **Isolated from auth flow**: The guest report branch returns early — it cannot accidentally fall through to authenticated-only handlers.

### Fixup: `roadmapUrl` in email template

`buildWelcomeEmailHtml()` (email.server.ts line 215) has `const roadmapUrl = ${SHOPIFY_STORE_URL}/pages/roadmap`. After this pivot, the Roadmap IS the homepage. Update to `SHOPIFY_STORE_URL` (root URL). This affects all emails — welcome, report, and guest report.

### Files to modify
- `app/lib/email.server.ts` — extract `buildReportHtml()` + `sendEmail()` + `escapeHtml()`, update `roadmapUrl`, refactor `generateReportHtml()` and `checkAndSendWelcomeEmail()` to use them
- `app/routes/api.measurements.ts` — new `guestReport` branch before auth gate + `handleGuestReport()` function + `checkGuestReportLimit()`
- `app/lib/klaviyo.server.ts` — **new file** (~20 lines)
- `widget-src/src/components/ResultsPanel.tsx` — email capture UI replacing guest CTA banner
- `widget-src/src/lib/api.ts` — new `sendGuestReport()` function
- `widget-src/src/styles.css` — email capture styles

---

## 3. Post-Email User Flow

### After email is sent successfully:

**State machine in ResultsPanel:** `idle → sending → sent → prompt-account → blog-posts`

**Step 1: Success message** (state: `sent`)
"Check your inbox! Your personalized health plan has been sent."

**Step 2: Account creation prompt** (state: `prompt-account`, shown after 2s delay or on dismiss of success)
"Want to save your data and track changes over time? Your plan updates automatically as guidelines change."
→ "Create Free Account" button (links to Shopify account creation URL)
→ Small "Maybe later" dismiss link

**Step 3: Latest blog posts** (state: `blog-posts`, shown after account creation or dismissal)
Show the 3 most recent blog posts from `docs/blog/index.json` as clickable cards (title + tag). This keeps users engaged with valuable content rather than bouncing, and avoids the trust-undermining effect of pushing a sales page immediately after collecting health data.

**Implementation**: The blog index is already a static JSON file. Baked into the widget at build time — import the top 3 entries as a constant. Blog posts update on deploys (when the widget is rebuilt anyway).

**After dismiss of blog posts or clicking a post**: CTA collapses back to the email field with a "Resend" option (in case they want to update their email or send again).

### Files to modify
- `widget-src/src/components/ResultsPanel.tsx` (state machine + UI for all steps)
- `widget-src/src/styles.css` (success/prompt/blog-card styles)

---

## Data Flow Diagram

```
Guest enters health data (stored in localStorage, displayed via React state)
         ↓
Enters email + clicks "Get Your Personalized Plan"
         ↓
Client-side: validate email format
         ↓
POST /apps/health-tool-1/api/measurements
  { guestReport: { email, inputs, medications?, screenings? } }
         ↓
Server-side (HMAC-verified, before customerId auth gate):
  ├─ z.string().email() on email
  ├─ healthInputSchema.safeParse() on inputs (reused)
  ├─ checkGuestReportLimit() by email (5/24h)
  ├─ buildReportHtml(inputs, medications, screenings) ← shared with authenticated flow
  ├─ sendEmail(email, subject, html)                  ← shared with authenticated flow
  └─ subscribeToKlaviyo(email) (fire-and-forget)
         ↓
Return { success: true }
         ↓
Client: "Check your inbox!" → "Create Free Account" prompt → blog posts
         ↓
    ┌──── Creates account ────┐       ┌──── Dismisses ────┐
    ↓                         ↓       ↓                    ↓
Shopify login              sync-embed  Show latest 3       Show latest 3
    ↓                      pushes      blog posts          blog posts
localStorage data →        localStorage →
Supabase (existing flow)   Supabase (existing flow)
```

**Key insight**: The "account merge" problem disappears entirely. Guest data lives in localStorage. When the guest creates an account and logs in, sync-embed already pushes localStorage to Supabase. This is the existing flow — zero new code needed for data migration.

---

## Files Summary

| File | Changes |
|------|---------|
| `widget-src/src/components/MobileTabBar.tsx` | Simplify to 2 tabs (Input \| Plan) |
| `widget-src/src/components/HealthTool.tsx` | Mobile 2-tab scroll-snap layout, floating CTAs |
| `widget-src/src/components/ResultsPanel.tsx` | Inline email capture, post-email state machine (success → account → blog posts) |
| `widget-src/src/lib/api.ts` | New `sendGuestReport()` function |
| `widget-src/src/styles.css` | Scroll-snap tabs, floating CTAs, email capture, success/prompt/blog-card styles |
| `app/lib/email.server.ts` | Extract `buildReportHtml()` + `sendEmail()`, add `escapeHtml()`, update `roadmapUrl`, refactor existing callers |
| `app/routes/api.measurements.ts` | New `guestReport` branch before auth gate + `handleGuestReport()` + rate limiter |
| `app/lib/klaviyo.server.ts` | **New** (~20 lines) — Klaviyo subscribe helper |

**Not modified** (intentionally):
- `app/lib/supabase.server.ts` — no guest profiles, no new auth path
- `packages/health-core/` — no changes to progressive disclosure, validation, or calculation logic
- `extensions/health-tool-widget/blocks/sync-embed.liquid` — existing localStorage→Supabase flow unchanged
- `shopify.app.toml` — no new app proxy entry needed (reuses existing `/api/measurements` path)

---

## Verification

1. **Guest email flow**: Enter health data → enter email → receive report email with correct suggestions and metrics
2. **Authenticated email unchanged**: Logged-in "Email My Plan" still works via existing `sendReportEmail()` → `generateReportHtml()` → `buildReportHtml()` (same result, refactored path)
3. **Welcome email unchanged**: `checkAndSendWelcomeEmail()` refactored to use `buildReportHtml()` — same output, verify manually
4. **Email validation**: Invalid emails show inline error client-side (no server call). Server also validates via Zod.
5. **Rate limiting**: 6th email to same address within 24h returns 429 with user-friendly message
6. **Klaviyo**: Email appears in "Roadmap Guests" list with `roadmap-guest` tag
7. **Mobile 2-tab layout**: Swipe between Input and Plan tabs, scroll-snap settles correctly
8. **Floating CTA**: "View Your Plan" hidden when `formStage < 2` (sex + height not yet entered), visible after
9. **Post-email flow**: Success → account prompt → latest 3 blog posts → dismiss returns to email field
10. **sync-embed unchanged**: After account creation, localStorage pushes to Supabase exactly as before
11. **Blog posts**: 3 most recent posts from `index.json` render as clickable cards with correct URLs
12. **Medications in guest report**: Guest with medications entered → email includes medication-aware suggestions (statin escalation etc.)
13. **Guest with minimal data**: Guest enters only height + sex → email contains IBW, protein target, and basic suggestions (no medication/screening sections)

## Implementation Order

1. **Email refactor** in `email.server.ts` — extract `buildReportHtml()` + `sendEmail()` + `escapeHtml()`, refactor existing callers. Run `npm test` to verify no regressions.
2. **Guest report backend** (`handleGuestReport` in `api.measurements.ts` + `klaviyo.server.ts`)
3. **Mobile 2-tab layout** — biggest UX change, independent of backend
4. **Email capture UI** in ResultsPanel + `sendGuestReport()` in api.ts
5. **Post-email flow** (success → account prompt → blog posts)

## Open Questions

1. **Klaviyo list ID**: Brad needs to create a "Roadmap Guests" list in Klaviyo and add `KLAVIYO_LIST_ID` to `.env`
2. **Fly.io env**: `KLAVIYO_API_KEY` and `KLAVIYO_LIST_ID` need to be set as Fly secrets for production
3. **Blog posts staleness**: Blog post cards are baked into the widget at build time from `docs/blog/index.json`. They update whenever the widget is rebuilt (which happens on deploys). If this becomes a staleness issue, can switch to runtime fetch later.

---

# STAGE 2: Hero Section + A/B Testing Dashboard

## Context

Stage 1 makes the widget the homepage's centerpiece with email capture. Stage 2 adds:
1. A **hero section** (Brad's image + heading/subheading) built into the app block itself
2. An **A/B testing system** to optimize heading copy for email conversions, managed entirely from the Shopify app dashboard

The hero must be part of the app block (not the Shopify theme) so that A/B test variants can be controlled programmatically. If the heading lived in the theme, changing it would require manual Shopify admin edits — unusable for automated experiments.

---

## Design Decisions & Rationale

### Why the hero lives outside the React mount point

The hero (image + heading + subheading) is rendered as static HTML in `app-block.liquid`, **above** the `#health-tool-root` div that React mounts into. React never touches the hero.

Why this matters:
1. **Performance**: The hero image and heading render instantly as pure HTML/CSS. The 881KB React bundle loads with `defer` — if the hero were inside React, visitors would see a skeleton placeholder for 1-2 seconds before the heading appeared.
2. **CLS prevention**: The hero's dimensions are locked by CSS before any JS executes. No layout shift.
3. **A/B text swap is instant**: A synchronous inline script (~10 lines, <0.1ms) picks the variant before the browser's first paint. No flash.

The tradeoff: the hero can't use React state or components. This is fine — the hero is static content (an image, a heading, a subheading). It doesn't need interactivity.

### Why Shopify metafields for A/B config delivery

The A/B test configuration (which variants exist, what their heading/subheading text is) needs to get from the admin dashboard into the storefront HTML. Three options were considered:

1. **API call from widget** — Rejected. Any fetch before rendering the heading causes either a flash (async) or a delay (blocking). Both are unacceptable for the homepage hero.

2. **Hardcoded in Liquid template** — Rejected. Changing variants would require a Shopify extension deploy (`npx shopify app deploy --force`). You can't iterate on A/B tests if each change takes 2 minutes to deploy.

3. **Shopify shop metafield** ✅ — The admin dashboard writes test config to `shop.metafields.health_roadmap.ab_config` via the Admin GraphQL API. Liquid reads the metafield at page render time and outputs ALL variant headings into the HTML (non-active ones hidden with `style="display:none"`). A tiny inline script picks one based on localStorage. No API call needed. Config changes are live within Shopify's metafield cache TTL (~1-2 minutes). No deploy needed.

### Why Supabase for event tracking (not Shopify metafields or counters)

A/B testing requires tracking impressions (page views per variant) and conversions (email captures per variant), then computing statistical significance.

Metafield-based counters were considered: store `{ a: { impressions: 1234, conversions: 56 } }` and increment on each event. Rejected because:
1. **Race conditions**: Two visitors hit the page simultaneously → both read count 1234 → both write 1235 → one impression lost. Metafields have no atomic increment.
2. **No deduplication**: Same visitor refreshing the page would inflate impression counts. Metafields have no UNIQUE constraints.
3. **Data loss**: Any workaround (in-memory buffering, periodic flush) loses data on server restart. Fly.io machines restart on deploys.

Supabase handles all three natively: `INSERT ... ON CONFLICT DO NOTHING` for deduplication, concurrent writes are safe, data persists across deploys.

### Why a two-proportion z-test for statistical significance

This is the standard test for comparing conversion rates between two groups. It answers: "Is the difference in conversion rates statistically significant, or could it be due to random chance?"

Alternatives considered:
- **Chi-squared test**: Equivalent for 2×2 contingency tables; z-test is simpler to implement and interpret.
- **Bayesian approach**: More nuanced but harder to explain in a dashboard. A p-value + confidence level is universally understood.
- **No significance testing**: Rejected. Without it, Brad might declare a winner based on noise (e.g., 5.1% vs 4.9% with 50 visitors).

---

## Hero Section

### Layout

**Desktop (>768px):**
```
┌────────────────────────────────────────────────┐
│  H1 + Subheading (55%)    │  Brad's image (45%)│
├────────────────────────────────────────────────┤
│  [Input Form]          │  [Results Panel]       │
│  (existing two-column widget layout)            │
└────────────────────────────────────────────────┘
```

**Mobile (≤768px):** Same side-by-side layout. Image shrinks to ~20-25% width. H1 and subheading scale down with `clamp()` font sizes.

### Hero HTML structure

```html
<!-- Hero: outside React mount point, never replaced -->
<div class="hero-section">
  <div class="hero-text">
    <h1>Get Your Personalized Health Plan</h1>
    <p>Enter your health information below...</p>
  </div>
  <div class="hero-image">
    <img src="..." srcset="..." fetchpriority="high" width="..." height="...">
  </div>
</div>

<!-- React mounts here (form + results only) -->
<div id="health-tool-root">
  ...skeleton blocks (no header — hero replaces it)...
</div>
```

### Hero image hosting

The image URL is hardcoded in `app-block.liquid` pointing to the Shopify Files CDN. `width` and `height` attributes on the `<img>` tag + `aspect-ratio` in CSS lock the layout before the image downloads, preventing CLS.

### Hero scope

The hero appears on **every page** that has the widget app block — homepage, `/pages/roadmap`, etc. No conditional logic needed.

---

## A/B Testing System

### Architecture overview

```
┌─────────────────────────────────────────────────────────────┐
│  Admin Dashboard (/app/ab-testing)                          │
│  Create test → Save to Supabase → Write Shopify metafield   │
│  View results → Query Supabase → Calculate z-test            │
└──────────────┬──────────────────────────────────┬───────────┘
               │                                  │
       Supabase (source of truth)      Shopify metafield (delivery)
       ab_tests, ab_events             shop.metafields.health_roadmap.ab_config
               │                                  │
               │                    ┌─────────────┘
               │                    ▼
               │         Liquid renders ALL variant values
               │         for the targeted element into HTML
               │                    │
               │                    ▼
               │         Inline script picks one
               │         variant from localStorage
               │         (before first paint)
               │                    │
               │                    ▼
               │         React mounts, fires impression
               │         beacon via sendBeacon()
               │                    │
               │                    ▼
               └──── POST /api/ab ──┘
                     (impression or conversion event)
```

### Config delivery via Shopify metafields

When a test is activated in the admin dashboard:
1. Test config saved to Supabase (source of truth for test metadata + results)
2. Config written to `shop.metafields.health_roadmap.ab_config` via Admin GraphQL API

Liquid reads the metafield and renders variants for the targeted element only. Each test has a `target` (`'heading'` or `'subheading'`) and variants with a single `value` field:

```liquid
{% assign ab = shop.metafields.health_roadmap.ab_config.value %}
{% if ab and ab.target == 'heading' %}
  {% for variant in ab.variants %}
    <h1 data-variant="{{ variant.id }}" data-test="{{ ab.testId }}"
        {% unless forloop.first %}style="display:none"{% endunless %}>
      {{ variant.value }}
    </h1>
  {% endfor %}
{% else %}
  <h1>{{ default_heading }}</h1>
{% endif %}
{% if ab and ab.target == 'subheading' %}
  {% for variant in ab.variants %}
    <p data-variant="{{ variant.id }}" data-test="{{ ab.testId }}"
       {% unless forloop.first %}style="display:none"{% endunless %}>
      {{ variant.value }}
    </p>
  {% endfor %}
{% else %}
  <p>{{ default_subheading }}</p>
{% endif %}
```

This means heading and subheading tests are independent — you run one at a time. The untested element always shows its default. To add new testable elements in the future, add a new `ab.target` value and a corresponding Liquid block.

### Variant assignment (inline script)

Runs synchronously before first paint (~0.1ms). Same pattern as the existing auto-redirect script already in `app-block.liquid` (lines 14-28).

```javascript
(function() {
  var KEY = 'hr_ab';
  var els = document.querySelectorAll('[data-variant]');
  if (!els.length) return; // no active test

  // Collect unique variant IDs
  var testId = els[0].dataset.test;
  var ids = [];
  els.forEach(function(e) {
    if (ids.indexOf(e.dataset.variant) < 0) ids.push(e.dataset.variant);
  });

  // Check localStorage for existing assignment
  var stored = null;
  try { stored = JSON.parse(localStorage.getItem(KEY)); } catch(e) {}

  // Reassign if stored test doesn't match current test
  var v = (stored && stored.t === testId) ? stored.v : null;
  if (!v || ids.indexOf(v) < 0) {
    v = ids[Math.floor(Math.random() * ids.length)];
    localStorage.setItem(KEY, JSON.stringify({ t: testId, v: v }));
  }

  // Show assigned variant, hide others
  els.forEach(function(e) {
    e.style.display = e.dataset.variant === v ? '' : 'none';
  });
})();
```

**Why this doesn't flash**: All variant texts exist in the server-rendered HTML. The script doesn't fetch or create text — it only toggles `display` on elements that are already in the DOM. The browser hasn't painted yet when this runs (synchronous script before any deferred content).

**Test ID mismatch**: If Brad activates a new test, returning visitors have a stale test ID in localStorage. The script detects the mismatch (`stored.t !== testId`) and reassigns. This is correct behavior — a new test should start fresh.

### Database schema

```sql
CREATE TABLE ab_tests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft', 'active', 'paused', 'completed')),
  target TEXT NOT NULL DEFAULT 'heading',
  variants JSONB NOT NULL,
  -- Example: [
  --   { "id": "a", "value": "Get Your Personalized Health Plan", "weight": 50 },
  --   { "id": "b", "value": "Free Health Recommendations...", "weight": 50 }
  -- ]
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE ab_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  test_id UUID NOT NULL REFERENCES ab_tests(id),
  variant_id TEXT NOT NULL,
  visitor_id TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN ('impression', 'conversion')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (test_id, visitor_id, event_type)
);
```

**Visitor ID**: Random UUID generated on first visit, stored in `localStorage('hr_vid')`. Shared across all tests. The `UNIQUE (test_id, visitor_id, event_type)` constraint means:
- Refreshing the page doesn't add duplicate impressions (`INSERT ... ON CONFLICT DO NOTHING`)
- Submitting email twice doesn't double-count conversions
- Same visitor can have both an impression AND a conversion (different `event_type`)

**No RLS needed**: Both tables are accessed exclusively via the service key — admin dashboard reads (bypasses RLS) and the storefront `api.ab.ts` endpoint writes (also service key, since guests have no Supabase auth). Standard `GRANT` permissions suffice.

### Event tracking

**Impressions**: After React mounts, `trackABImpression()` reads the assigned variant from localStorage and fires a POST via `fetch` (wrapped in `apiCall` for error handling). A localStorage flag (`hr_ab_imp_<testId>`) prevents redundant network calls on subsequent page loads — server-side deduplication via UNIQUE constraint is the safety net. One impression per visitor per test.

**Conversions**: When guest email is captured successfully, `trackABConversion()` fires a POST with the test/variant/visitor IDs. Recorded in `ab_events` via the same `api.ab.ts` endpoint.

**API endpoint**: `POST /apps/health-tool-1/api/ab` — new route `app/routes/api.ab.ts`. HMAC-verified via `authenticate.public.appProxy()`. Uses existing app proxy config (all `/apps/health-tool-1/*` paths proxy to Fly.io — no `shopify.app.toml` change needed).

### Admin dashboard

**New route: `app/routes/app.ab-testing.tsx`**

Uses Shopify Polaris components, consistent with the existing dashboard at `app._index.tsx`.

**Test list view:**
- Table of all tests with status badges (draft / active / paused / completed)
- "Create Test" button
- Click a test to see results

**Create test:**
- Test name
- Target element selector: Heading / Subheading (extensible to future elements)
- Variant A and B values (the text for the selected element)
- "Create Test" button (saves as draft)

**Results view:**
- Per-variant row: impressions, conversions, conversion rate
- Relative improvement (e.g., "+12% vs control")
- Statistical significance indicator
- "Winner" badge when significance threshold is met
- "Pause" / "Complete" buttons

**Activating a test:**
1. Pauses any currently active test (only one active at a time)
2. Saves test to Supabase
3. Writes config to Shopify metafield via `admin.graphql()` (Admin GraphQL API, available from `authenticate.admin(request)`)
4. If metafield write fails → show error with "Retry" button. Test data is safe in Supabase; only storefront delivery is affected.

**Pausing/completing a test:**
1. Updates status in Supabase
2. Deletes the Shopify metafield → storefront falls back to default heading

**NavMenu**: Add "A/B Tests" link in `app/routes/app.tsx`.

### Statistical significance

**Two-proportion z-test**, computed server-side in the loader:

```
p_a = conversions_a / impressions_a
p_b = conversions_b / impressions_b
p_pool = (conversions_a + conversions_b) / (impressions_a + impressions_b)
z = (p_a - p_b) / sqrt(p_pool * (1 - p_pool) * (1/n_a + 1/n_b))
p_value = 2 * (1 - Φ(|z|))    // two-tailed test
```

Dashboard display:
- **"Not enough data"** — fewer than 100 impressions per variant
- **"Not significant"** — p > 0.05
- **"Significant (95% confidence)"** — p ≤ 0.05
- **"Highly significant (99% confidence)"** — p ≤ 0.01

~15 lines of TypeScript. Normal CDF approximated via Abramowitz & Stegun rational function. No external stats library needed.

### Shopify scopes

Current scopes: `write_app_proxy,read_customers,write_customers,read_orders,read_all_orders`

App-owned metafields (created via the app's own Admin API session) should not require additional scopes on Shopify API version 2025-10 — apps have implicit access to their own metafields. To verify during implementation: attempt a `metafieldsSet` mutation in the admin route. If it fails with a scope error, add `read_metafields,write_metafields` to `shopify.app.toml` and redeploy.

---

## Pitfalls & Edge Cases

| Scenario | Behavior | Why this is safe |
|----------|----------|-----------------|
| No active test | Liquid renders default heading. Inline script finds no `[data-variant]` elements, exits immediately. | The `{% else %}` branch in Liquid guarantees a heading always appears. |
| Test changed (new test activated) | Inline script detects test ID mismatch in localStorage → clears stale assignment → picks new variant randomly. | Returning visitors don't get stuck on old test's variant. New test starts with a clean slate. |
| Test paused mid-experiment | Metafield deleted → Liquid renders default heading. Old localStorage data is harmless (no matching `data-variant` elements to toggle). | No JS errors. Impression beacons will fail silently (no active test in DB). |
| Visitor clears localStorage | Gets randomly reassigned on next visit. | Minor noise in the data. At scale (hundreds of visitors), impact is negligible. |
| Multiple tabs open | Same localStorage → same variant assignment across tabs. | Consistent experience. Impression only recorded once (DB dedup). |
| JS disabled | First variant visible via HTML (no `style="display:none"`). Others hidden. | SEO crawlers see the control variant. A/B test only runs for JS-enabled visitors (>99% of real users). |
| Shopify metafield cache delay | ~1-2 minutes between admin activating a test and storefront showing new variants. | A/B tests run for days/weeks. A 2-minute delay on activation is immaterial. |
| Dual write failure (Supabase succeeds, metafield fails) | Test data is safe in Supabase. Storefront shows default heading until metafield write is retried. | Admin UI shows error with "Retry" button. No data loss. |
| Impression fetch fails (network error) | Impression not recorded for that visitor. | `apiCall` wrapper catches and logs. At scale, a few lost impressions don't affect statistical significance. |
| Concurrent impression writes | Supabase handles concurrent `INSERT ... ON CONFLICT DO NOTHING` natively. | No race conditions, no lost data. |
| Extension size limit (10MB) | Hero image URL hardcoded to Shopify Files CDN, not stored as extension asset. | The 881KB JS bundle + CSS already take significant space. Adding a hero image as an asset would risk hitting the limit. |

---

## Files Summary (Stage 2)

### Hero
| File | Changes |
|------|---------|
| `extensions/health-tool-widget/blocks/app-block.liquid` | Add hero HTML above `#health-tool-root`, remove old `<h2>/<p>` from skeleton |
| `widget-src/src/styles.css` | `.hero-section` grid, `.hero-text` typography, `.hero-image` sizing, mobile responsive. Remove `.health-tool-header` styles. |
| `widget-src/src/components/HealthTool.tsx` | Remove `.health-tool-header` div (lines 872-878) |

### A/B Testing
| File | Changes |
|------|---------|
| `supabase/rls-policies.sql` | Add `ab_tests` (with `target` column) + `ab_events` tables |
| `extensions/health-tool-widget/blocks/app-block.liquid` | Metafield-driven variant rendering (target-based) + inline A/B script |
| `app/routes/api.ab.ts` | **New** — POST impression/conversion events (HMAC-verified, Zod-validated, rate-limited) |
| `app/routes/app.ab-testing.tsx` | **New** — Admin dashboard: create/manage tests, view results with z-test significance |
| `app/routes/app.ab-testing.test.ts` | **New** — Unit tests for normalCDF + calculateSignificance (13 tests) |
| `app/lib/ab-stats.ts` | **New** — Statistical significance functions (normalCDF, calculateSignificance) |
| `app/lib/rate-limiter.ts` | **New** — Extracted shared rate limiter factory (used by api.measurements + api.ab) |
| `app/routes/app.tsx` | Add "A/B Tests" to NavMenu |
| `app/lib/supabase.server.ts` | AB query helpers (create test, update status, record event, get results) |
| `widget-src/src/lib/api.ts` | Impression/conversion tracking helpers, visitor ID generation, localStorage dedup |
| `widget-src/src/components/HealthTool.tsx` | Fire impression on mount |
| `widget-src/src/components/ResultsPanel.tsx` | Fire conversion on successful email capture |

### Not modified (intentionally)
- `shopify.app.toml` — existing app proxy covers `/api/ab`. Metafield scopes likely not needed (app-owned). Verify during implementation.
- `packages/health-core/` — no health calculation changes
- `sync-embed.liquid` — existing sync flow unchanged
- `app/routes/api.measurements.ts` — conversion event recorded in `api.ab.ts`, not here (separation of concerns). Guest report handler (Stage 1) passes through variant info but doesn't record it itself.

---

## Implementation Order (Stage 2)

### Phase 1: Hero (visual, no A/B yet)
1. Hero HTML + CSS in `app-block.liquid` + `styles.css`
2. Remove old header from `HealthTool.tsx`
3. Build widget, deploy, verify hero renders correctly on desktop + mobile

### Phase 2: A/B Infrastructure
4. Create Supabase tables (`ab_tests`, `ab_events`) via SQL migration
5. Add AB query helpers to `supabase.server.ts`
6. Create `api.ab.ts` endpoint (impression/conversion tracking)
7. Add metafield-driven variant rendering + inline A/B script to `app-block.liquid`
8. Add React-side AB logic (visitor ID, impression beacon, conversion tracking in email capture)

### Phase 3: Admin Dashboard
9. Create `app.ab-testing.tsx` (Polaris UI: test list, create, results)
10. Add metafield write on test activation/pause via Admin GraphQL API
11. Add NavMenu link
12. Implement z-test statistical significance display

### Phase 4: Deploy + Verify
13. Verify metafield scopes (add to `shopify.app.toml` if needed, redeploy)
14. Build widget, deploy extensions + backend
15. Create first test via dashboard, verify end-to-end flow

---

## Verification (Stage 2)

1. **Hero renders instantly** — image + heading visible before React loads (disable JS to confirm)
2. **No CLS** — Lighthouse audit shows 0 CLS from hero section
3. **Mobile layout** — side-by-side with small image (~20-25% width) on right
4. **SEO** — view source shows control heading in raw HTML (no JS needed for crawlers)
5. **No flash on A/B swap** — all variants server-rendered, script picks one before paint
6. **A/B assignment sticky** — clear localStorage, reload → get assigned. Reload again → same variant
7. **Test change handled** — activate new test → returning visitors get reassigned
8. **No active test fallback** — delete metafield → default heading shows, no JS errors
9. **Impressions deduplicated** — refresh page → no duplicate rows in `ab_events`
10. **Conversion tracked** — submit email → `ab_events` has conversion row with correct test/variant
11. **Dashboard results** — impressions, conversions, conversion rates per variant displayed correctly
12. **Statistical significance** — with sufficient test data, correct p-value and confidence level shown
13. **Only one active test** — activating a new test pauses the currently active one
14. **Metafield retry** — if metafield write fails, error message + retry button in admin UI
