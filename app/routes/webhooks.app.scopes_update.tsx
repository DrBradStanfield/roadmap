import type { ActionFunctionArgs } from "react-router";
import { authenticate, sessionStorage } from "../shopify.server";
import { cappedRequest, WEBHOOK_BODY_CAP } from "../lib/capped-body.server";

export const action = async ({ request }: ActionFunctionArgs) => {
    // The library reads the whole body before its HMAC check (US-09 AC25).
    const capped = await cappedRequest(request, WEBHOOK_BODY_CAP);
    if (!capped) return new Response(null, { status: 413 });
    const { payload, session, topic, shop } = await authenticate.webhook(capped);
    console.log(`Received ${topic} webhook for ${shop}`);

    const current = payload.current as string[];
    if (session) {
        session.scope = current.toString();
        await sessionStorage.storeSession(session);
    }
    return new Response();
};
