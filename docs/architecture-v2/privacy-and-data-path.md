---
title: Roadmap Privacy and Data Path
artifact: https://claude.ai/artifact/PAYdAiwrtZoGeYyLemfcAs
---

# Privacy & data path

Part of [Health by Dr Brad — Architecture (v2, local-first)](../architecture-v2.md).

<a id="data-path"></a>
## The data path never stores anything with Brad

> **Guarantee —** **The core invariant.** Reads and writes of health data flow only between the browser and the user's chosen cloud. No measurement, lab value, medication, or document ever transits Brad's server. The only things that reach Fly are: AI request *content* (in-memory, never stored) and a reminder's *due date + label + verified email + capability token*.

This is what makes the "works if Brad goes dark" guarantee real. If Fly is down: the app still loads (Pages build is static; the Shopify build is served by Shopify's CDN), still computes results, still reads/writes the user's cloud. Only the optional extras — server-side chat, server lab extraction, reminder scheduling — pause, and on the Pages build even chat and upload keep working via BYOK.

<a id="thin-server"></a>
## Brad's thin server — what it does and doesn't

#### Does

- **Chat** for the storefront (free; shoppers won't paste API keys)
- **Lab PDF extraction** for the storefront (extracted text transits; never stored)
- **Reminder scheduling** — stores only verified email + due item + date + capability token
- **Google token exchange** (stateless), **Klaviyo capture**, **A/B events**, **feedback**
- Ops crons + the Discord/YouTube bots + the Polaris admin app

#### Doesn't

- Store any health values, history, or reasoning
- Hold any credential for the user's cloud
- Mint per-user identity or gate features behind a paid tier (there is none)
- Keep a read path for emails — no list, lookup, or search endpoint exists
- Persist AI request content beyond the request

<a id="positioning"></a>
## Honest positioning

> **Note —** The approved claim is *"Your health data lives in the cloud account you already use and trust — not on our servers."* It is deliberately **not** marketed as "encrypted" or "maximum privacy": there is no client-side encryption by default (a forgotten key is the worst failure mode for the grandma avatar), so Google/Dropbox can technically read the file. Self-host is the provider-proof path for the \<1% who want it. Data minimisation, not de-clinicalisation: a reminder still says "your 5-yearly colonoscopy is due" — being specific is the point — but the server never keeps *why*.
