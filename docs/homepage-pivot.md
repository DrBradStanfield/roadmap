# Plan: Homepage Pivot — Roadmap Widget as Homepage Hero

## Context

The homepage currently functions as a supplement sales page. The Health Roadmap tool — Brad's main differentiator and lead capture device — is buried behind a tiny parenthetical link. This pivot makes the Roadmap widget the homepage's centerpiece, with a new lightweight email capture flow that doesn't require Shopify account creation.

Brad will handle the Shopify theme/homepage layout changes (hero image, heading, navigation restructuring). This plan covers the **widget code changes** only.

### Homepage text (Brad implements in Shopify theme)

- **Heading**: "Get Your Personalized Health Plan"
- **Subheading**: "Enter your health information below to receive personalized suggestions to discuss with your healthcare provider."
- The widget replaces the 3 Pillars section and "As a Family Medicine Doctor..." intro text
- `/pages/roadmap` redirects to homepage

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
