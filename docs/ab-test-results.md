# A/B Test Results — May 2026

Snapshot of the two A/B tests that ran from 2026-04-09 through 2026-05-14. Both tests showed cumulative sample-ratio mismatch on the dashboard, which turned out to be residual data from before the bot-fix in `bf54559` (deployed 2026-05-01). After splitting impressions by pre/post fix, the system is balanced.

## Why the dashboard numbers were misleading

The dashboard aggregates all impressions/conversions since test creation. Both tests started 22 days before the bot fix and accumulated SRM during that window:

| Test | Pre-fix B/A impressions | Post-fix B/A impressions |
|---|---|---|
| Subheading | 1.24 (skewed) | **1.000** (916 vs 916) |
| email helper | 1.33 (skewed) | **0.955** (896 vs 938) |

Post-fix impressions are within statistical noise of 50/50 — the bot guard (`navigator.webdriver` + `isbot` UA check, added in `bf54559`) is working as designed. The dashboard's headline numbers mix two statistical populations and should not be trusted directly while these tests remain active.

## Email helper test (`email-guest-helper`)

**Verdict: Variant A wins. Locking in Variant A.**

| | Variant A | Variant B |
|---|---|---|
| Copy | "Get your personalized plan emailed to you, with detailed explanations and clinical references for every suggestion." | "Your plan emailed to you, with detailed explanations and clinical references." |
| Pre-fix impressions | 2032 | 2698 |
| Post-fix impressions | 938 | 896 |
| Pre-fix conversions | 65 | 56 |
| Post-fix conversions | 47 | 25 |
| **Post-fix conversion rate** | **5.01%** | **2.79%** |

**Post-fix-only two-proportion z-test:** B vs A lift = **−44.3%**, z = −2.45, **p = 0.0144** (significant).

The dashboard's "−40.2%, p=0.0003" verdict held up after removing bot-poisoned data. Variant A's longer, more specific framing ("for every suggestion") converts roughly **1.8× better** than Variant B's terse version. Effect size is large enough to act on.

## Subheading test (`subheading`)

**Verdict: Inconclusive. Keep running.**

| | Variant A | Variant B |
|---|---|---|
| Copy | "Enter your health information below to receive personalized suggestions to discuss with your healthcare provider. The more information you provide, the more tailored your suggestions will be." | "Enter your information below to receive personalized suggestions to discuss with your doctor." |
| Pre-fix impressions | 2118 | 2624 |
| Post-fix impressions | 916 | 916 |
| Pre-fix conversions | 60 | 62 |
| Post-fix conversions | 33 | 39 |
| **Post-fix conversion rate** | **3.60%** | **4.26%** |

**Post-fix-only two-proportion z-test:** B vs A lift = **+18.2%**, z = 0.72, **p = 0.47** (not significant).

The dashboard's "B is −6.9%" framing is bot-induced. Post-fix data hints Variant B (the shorter copy) may actually be better, but the sample is too small to call — only 72 post-fix conversions across both arms. Re-evaluate when post-fix conversions reach ~200 per arm.

## Methodology

Computed by paginating `ab_events` for each active test, bucketing by `event_type` and `created_at < 2026-05-01T00:00:00Z`, then running a two-proportion z-test on the post-fix counts. Diagnostic script was a one-off; not checked in.

Bot-fix history is documented in commit `bf54559` ("Filter bot traffic from A/B test events to fix SRM"). Design rationale for the A/B system is in [homepage-pivot.md](homepage-pivot.md) Stage 2.

## Implication for the dashboard

The admin dashboard at [app/routes/app.ab-testing.tsx](../app/routes/app.ab-testing.tsx) shows cumulative counts only and has no date filter. For any test that crosses a code-fix that materially affects traffic quality (like `bf54559`), cumulative numbers will mislead. Two options if this becomes a recurring problem:

1. Pass a `since` cutoff through `getABTestResults` in [app/lib/supabase.server.ts](../app/lib/supabase.server.ts) and add a date picker to the dashboard.
2. Always reset tests after any change to bot filtering / assignment logic.

Option 2 is operational; option 1 is the durable fix.
