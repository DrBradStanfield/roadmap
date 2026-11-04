import type { ActionFunctionArgs } from "react-router";
import * as Sentry from "@sentry/react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import { cappedRequest, WEBHOOK_BODY_CAP } from "../lib/capped-body.server";

// The library types the payload loosely, so `current` is unchecked. Without a
// scope list there is nothing to store: keep the stored scope and still answer
// 200, since a throw only makes Shopify retry a delivery that fails the same
// way (US-09 AC25a).
function sessionToUpdate<S>(session: S | undefined, current: unknown): S | undefined {
    if (Array.isArray(current)) return session;
    Sentry.captureMessage("scopes_update without a current scope list", {
        level: "warning",
        tags: { feature: "shopify_scopes_update" },
    });
    return undefined;
}

export const action = async ({ request }: ActionFunctionArgs) => {
    // The library reads the whole body before its HMAC check (US-09 AC25).
    const capped = await cappedRequest(request, WEBHOOK_BODY_CAP);
    if (!capped) return new Response(null, { status: 413 });
    const { payload, session, topic, shop } = await authenticate.webhook(capped);
    console.log(`Received ${topic} webhook for ${shop}`);

    const target = sessionToUpdate(session, payload.current);
    if (target) {
        target.scope = String(payload.current);
        await sessionStorage.storeSession(target);
    }
    return new Response();
};
