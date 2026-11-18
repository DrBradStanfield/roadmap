import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { labImportRequestSchema } from '../../packages/health-core/src/validation';
import { extractOneFile, forWidget, reportLabImportError } from '../lib/lab-extract-one.server';
import { IMPORT_LIMITS } from '../../packages/health-core/src/import-hints';
import { createQuotaCounter, DAY_MS, machineFiles } from '../lib/rate-limiter';
import { BODY_TOO_LARGE, getClientIp, parseSimpleRequestJson, verifyAppProxySignature } from '../lib/local-first-route.server';
import { SMALL_BODY_CAP } from '../lib/capped-body.server';

/**
 * Lab extraction for the LOCAL-FIRST storefront page (Phase 4 "thin server
 * AI"). Same Claude pipeline as api.lab-import.ts, but no Shopify session
 * and no accounts — the §7 posture: extracted text/images transit, results
 * return, nothing is stored.
 *
 * Access (Phase-5 hardening, 2026-06-11): requests come ONLY through the
 * Shopify app proxy (/apps/health-tool-1/api/lab-import-v2) and must carry a
 * valid proxy signature — supersedes the old cross-origin AI_ALLOWED_ORIGINS
 * check (an Origin header is forgeable; Shopify's HMAC is not). Same-origin
 * via the proxy, so no CORS machinery at all. The Pages/self-host build
 * extracts with the user's own key (byok-upload.ts) and never calls this
 * route. (Decision record §10 threat model.)
 *
 * Cost control (no identity to meter per-user):
 *  - per-IP daily file limit (anti-abuse): the upload window's own file cap,
 *    so one upload's files fit a fresh day (US-12 AC17)
 *  - a HARD per-machine daily file cap as the $-cap guardrail, shared with the
 *    connector's import (`machineFiles` in rate-limiter.ts, US-35 AC10). Tune
 *    via AI_DAILY_FILE_CAP (default 2000/day/machine, raised from 500 on 2026-10-21: 4x the old worst-case cost).
 */

const PER_IP_DAILY_LIMIT = IMPORT_LIMITS.websiteFiles;

// Per-IP daily file quota — same shared counter machinery the sibling
// local-first routes use (rate-limiter.ts), weighted by file count.
const ipQuota = createQuotaCounter(PER_IP_DAILY_LIMIT, DAY_MS, 30 * 60_000, { name: 'lab upload files per IP' });

/** Consume one file against the per-IP quota AND the machine $-cap; all or nothing. */
function consumeQuota(ip: string): boolean {
  if (!ipQuota.take(ip, 1)) return false;
  if (machineFiles.take('machine', 1)) return true;
  ipQuota.refund(ip, 1);
  return false;
}

// A 429's `code` tells the browser the daily limit from a busy server (US-12 AC9).
const dailyLimit = () => Response.json(
  { success: false, error: 'Daily upload limit reached. You can upload more tomorrow.', code: 'daily_limit' },
  { status: 429 },
);

const daySpent = (ip: string) => ipQuota.remaining(ip) === 0 || machineFiles.remaining('machine') === 0;
/**
 * US-12 AC17b: with no file left today for this IP or the machine, no read can
 * succeed, so no more than a small body is read, and a larger one gets the
 * daily-limit answer.
 */
function bodyLimit(ip: string): { cap: number; tooLarge: () => Response } {
  if (daySpent(ip)) return { cap: SMALL_BODY_CAP, tooLarge: dailyLimit };
  return { cap: 200 * 1024 * 1024, tooLarge: () => Response.json({ success: false, error: 'Request too large' }, { status: 413 }) };
}

/** GET: quota preflight only. */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!verifyAppProxySignature(request)) {
    return Response.json({ error: 'Forbidden' }, { status: 403 });
  }
  const ip = getClientIp(request, 'shopify');
  return Response.json({ allowed: !daySpent(ip), remaining: ipQuota.remaining(ip) });
}

/** POST: one file's extraction. */
export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== 'POST') return Response.json({ success: false, error: 'POST only' }, { status: 405 });
  if (!verifyAppProxySignature(request)) {
    return Response.json({ success: false, error: 'Forbidden' }, { status: 403 });
  }
  const ip = getClientIp(request, 'shopify');
  const limit = bodyLimit(ip);

  try {
    const body = await parseSimpleRequestJson(request, limit.cap);
    if (body === BODY_TOO_LARGE) return limit.tooLarge();

    const validation = labImportRequestSchema.safeParse(body);
    if (!validation.success) {
      return Response.json({ success: false, error: 'Invalid request' }, { status: 400 });
    }
    if (!consumeQuota(ip)) return dailyLimit();

    return extractOneFile(validation.data, () => ({ remaining: ipQuota.remaining(ip) }));
  } catch (error) {
    reportLabImportError(error);
    return Response.json({ success: false, error: 'Failed to process request' }, { status: 500 });
  }
}
