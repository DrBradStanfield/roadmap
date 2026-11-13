# S-21, S-23, S-24: one key for per-IP limits, and the bounded maps (design note)

Evidence: origin/main at 1ae32e9d1. Every limiter is in memory, per machine (app/lib/rate-limiter.ts). Trust mode is the second argument of `getClientIp` (app/lib/local-first-route.server.ts:151): `fly` reads Fly's `Fly-Client-IP`; `shopify` reads the shopper hop left of Fly's in `X-Forwarded-For` (:153-165). "Bucket" is `ipBucket` (app/lib/app-gate.server.ts:64): IPv6 to its /64; IPv4 and mapped IPv4 unchanged (:65-66).

## Today: every per-IP limiter

| Limiter (name) | Defined | Used | Window, limit | Key | Trust |
|---|---|---|---|---|---|
| app chat / app lab per IP | app-gate.server.ts:83 | :127 | day, 200 each | bucket | fly |
| app failures per IP | app-gate.server.ts:90 | :127 | day, 200 | bucket | fly |
| app registration attempts / registrations per IP | app-gate.server.ts:94, :96 | app-routes.server.ts:42 | day, 10 / 50 | bucket | fly |
| web chat turns per IP | rate-limiter.ts:188 | api.chat.ts:252 | day, 200 | bucket | shopify |
| guest chat sessions (hand-rolled) | supabase-guest.server.ts:38-40 | :94, :111; api.chat.ts:80 | hour, 10 | HMAC of address | shopify |
| feedback per IP | api.feedback.ts:13 | :33 | hour, 3 | address | shopify |
| events per IP / ab per IP | api.events.ts:12; api.ab.ts:14 | :29; :47 | hour, 600 each | address | shopify |
| email capture per IP | api.measurements.ts:19 | :55, :125 | hour, 20 | address | shopify |
| lab upload files per IP | api.lab-import-v2.ts:40 | :146, :156 | day, 200 files | address | shopify |
| google token per IP | api.google-token.ts:30 | :76 | minute, 30 | address | fly |
| reminders requests / opt-in per IP | api.reminders-v2.ts:53, :58 | :106-107, :130 | minute 20 / hour 20 | HMAC of address | fly |
| mcp authorize; mcp rate-limit events (a log brake) | mcp-grants.server.ts:266, :275 | mcp.$.tsx:176-180, :378 | minute, 20; 1 | address | fly |
| mcp reviewer failures | mcp-reviewer.server.ts:49 | mcp.$.tsx:375-390 | 15 min, 20 | address | fly |
| mcp token | mcp-grants.server.ts:284 | mcp.$.tsx:408 | minute, 300 | address | fly |

Not per IP, left alone: visitor, email, customer, key, connection, Discord user, machine. The lab join key also takes the address: `fileSetKey(ip, ...)` (lab-batches.server.ts:44, api.lab-import-v2.ts:177).

## The one key shape

`clientKey(request, trust) = ipBucket(getClientIp(request, trust))`, beside `getClientIp`; `ipBucket` moves there. A guard test fails on any `getClientIp` call outside `clientKey` that is not on a named list, as app/lib/ttl-bound.test.ts does for maps. Hashed limiters hash the bucket.

**IPv4:** the bucket is the address. Not a /24: that would join unrelated customers of one ISP. So for IPv4, carrier NAT and offices, nothing changes; they share one count today.

**Who notices:** only IPv6 networks. Devices on one /64 (a home or office LAN, a hotspot) count separately today and would share, as the same people do on IPv4. A device whose privacy address rotates keeps its count. Phones on mobile data each hold their own /64. Limits an IPv6 LAN would meet sooner: feedback (4th message in an hour), email capture (21st in an hour), guest sessions (11th new one in an hour), lab files (201st file a day, everyone together). events, ab, google token and reminders sit far above one LAN's use. Today a caller holding a /64 counts as many callers on the address-keyed limiters; the bucket counts it once.

## Recommendation per limiter

- The six bucket limiters: no change.
- feedback, events, ab, email capture, lab files, google token, mcp authorize, mcp rate-limit events, mcp reviewer failures: bucket, limits unchanged. Reminders (both): `hashClientIp(ipBucket(ip))`.
- Guest sessions: onto `createRateLimiter(10, hour)` keyed on the hashed bucket. The session's own address check (supabase-guest.server.ts:104) and its stored hash stay on the address (owner 2).
- mcp token: stays on the address, on the named list. Its callers are vendor servers whose users share an egress range (mcp-grants.server.ts:277-283); a /64 could fold thousands into one count of 300.
- Lab join key: stays on the address (owner 3). It is a join, not a limit.

Tests per change: per route, two IPv6 addresses in one /64 share the count (refused at limit + 1); two in different /64s do not; two IPv4 addresses do not. The guard test's named list shrinks with each PR.

## Build order (small PRs)

1. Move `ipBucket`, add `clientKey` and the guard test listing today's raw callers. No behaviour change.
2. feedback, events, ab, email capture. 3. Lab upload files (quota, `daySpent`, `remaining` on one key).
4. google token, reminders, mcp authorize, rate-limit events, reviewer failures.
5. Guest sessions onto `createRateLimiter`: deletes the hand-rolled map and sweep (about -10 prod LOC) and settles S-24's guestIpRateMap.

## S-23: clock order and the refused charge

(1) `boundedMap` (rate-limiter.ts:49-66) assumes insertion order is expiry order. If `Date.now()` steps back, a newer entry can expire before older ones; a full map then evicts its oldest live entry while an expired one waits behind it, until the next sweep. Readers still check expiry (`isLive`, :12), so no count is served wrongly; it matters only in a full map. Recommend: leave, and say so in the comment.
(2) `charge` (:104-114) inserts a count-0 entry before the limit check, so a new key refused outright holds a slot for one window. Only `n > limit` on a fresh key does it. Today's callers charge at most their limit (lab files at most 200 by health-core validation.ts:547; the rest charge 1), unless an env cap is 0. Fix: refuse `n > limit` before inserting, one line. Test: a full map, a fresh over-limit charge, then nobody evicted and no warning.

## S-24: maps with an expiry and no size bound

- guestIpRateMap (supabase-guest.server.ts:40): only its hourly sweep (:42-47) bounds it. The shared rule applies cleanly (PR 5) and fixes the edge: at exactly `resetAt`, :112 and :115 neither refuse nor reset.
- orderCache (chat-customer-cache.server.ts:12): keyed on the HMAC-verified customer id, 10 min (2 min when empty). A cache, so eviction is always safe; `boundedMap` and `sweepExpired` apply. Low value; recommend leave.
- activeBatches (lab-batches.server.ts:31): already bounded: a new batch is refused at 200 (api.lab-import-v2.ts:181). ttl-bound.test.ts:118 lists it because it seeks `.size` only in the defining file. Must never evict a paid, live batch. Fix the list; no prod change.
- undeletedBatches (lab-batches.server.ts:72): fed only by the sweep (:83-88); each batch spends at least one of the machine's 2000 files a day and leaves within 25 h (:91). Bounded by construction. Never evict: an evicted id is a batch never deleted upstream.
- spentCodes (mcp-grants.server.ts:149): one-use, 60 s, pruned on every claim (:160); entered only after the client, redirect and PKCE checks (mcp.$.tsx:434-440). Must never forget a live code: stays unbounded, like the spent challenges (app-gate.server.ts:99).
- spentProposals (:157): one-use, entered after the receipt verifies (mcp.server.ts:354), backed by the shared claim store. Must never forget early: stays unbounded.
- spentWrites (:194): not one-use; 60 writes an hour per authenticated connection (:219-227). Evicting hands a connection a fresh 60, so leave it. It could become a `createQuotaCounter` later, same fixed window.

## Decisions for the owner

1. Key shape: (a) bucket everywhere; (b) bucket everywhere but mcp token; (c) leave as is. Recommend (b).
2. Guest session binding: (a) the address, as now; (b) the bucket, so a rotating IPv6 device keeps its guest session (live sessions re-mint once). Recommend (a): only the limiter changes.
3. Lab join key: (a) the address, as now; (b) the bucket. Recommend (a).
4. S-23 refused charge: (a) the one-line fix; (b) leave. Recommend (a).
5. S-23 clock: (a) leave, documented; (b) a monotonic clock for the limiters. Recommend (a).
6. S-24: fix the activeBatches list entry, move guestIpRateMap (PR 5), leave the rest unbounded. Recommend yes.

## Decisions for Brad

1. No limit number changes. IPv6 homes and offices would share feedback (3 an hour), email capture (20 an hour), new guest chats (10 an hour) and lab files (200 a day), as IPv4 ones already do. Yes, or raise feedback (say to 10 an hour)? Recommend yes, unchanged. No new words: the refusal texts stay.
