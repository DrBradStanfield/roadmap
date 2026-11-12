// A scrub that throws sends nothing (US-09 AC7i). The SDK's own report about
// a fault in its pipeline (hint `data.__sentry__`) is marked by reference and
// rebuilt at the transport from a fixed allow-list; its breadcrumb is dropped.
// Plain ESM shared by the widget (sentry.ts) and the server
// (instrument.server.mjs, which is `node --import`-ed with no build step).

const selfReports = new WeakSet();

// The fields a rebuilt self-report copies: an allow-list, so a field a future
// SDK adds is dropped.
const SELF_REPORT_COPY = ["event_id", "timestamp", "platform", "level", "release", "environment"];

// A string or a finite number of bounded length, else nothing.
function scalar(value) {
  if (typeof value === "string") return value.length <= 200 ? value : undefined;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// A fresh object from the allow-list and the fixed words: nothing of the
// error's name, message or stack. Throws when a field cannot be read.
function freshSelfReport(event) {
  const out = {};
  for (const key of SELF_REPORT_COPY) {
    const value = scalar(event[key]);
    if (value !== undefined) out[key] = value;
  }
  const sdk = event.sdk;
  if (sdk !== null && typeof sdk === "object") {
    const name = scalar(sdk.name);
    const version = scalar(sdk.version);
    out.sdk = {
      ...(typeof name === "string" && { name }),
      ...(typeof version === "string" && { version }),
    };
  }
  out.message = "Sentry scrub pipeline error";
  out.exception = { values: [{ type: "SentryPipelineError", value: "dropped" }] };
  return out;
}

// An envelope that holds a marked report leaves rebuilt, with no trace header
// and no attachment; any other envelope is returned as is. Null drops the
// whole envelope: a rebuild that throws, or an event that cannot be inspected.
function rebuildEnvelope(envelope) {
  try {
    const [headers, items] = envelope;
    let marked = false;
    const kept = [];
    for (const [itemHeaders, payload] of items) {
      const inspectable = payload !== null && typeof payload === "object";
      if (inspectable && selfReports.has(payload)) {
        marked = true;
        kept.push([{ type: "event" }, freshSelfReport(payload)]);
      } else if (!inspectable && itemHeaders.type === "event") {
        return null;
      } else {
        kept.push([itemHeaders, payload]);
      }
    }
    if (!marked) return envelope;
    const rest = { ...headers };
    delete rest.trace;
    return [rest, kept.filter(([itemHeaders]) => itemHeaders.type !== "attachment")];
  } catch {
    return null;
  }
}

// Wraps a transport factory so every envelope passes the rebuild first.
export const selfReportTransport = (make) => (options) => {
  const inner = make(options);
  return {
    ...inner,
    send: (envelope) => {
      const next = rebuildEnvelope(envelope);
      return next ? inner.send(next) : Promise.resolve({});
    },
  };
};

// Marks the SDK's own report, or any event whose hint cannot be read. Listed
// first, so it runs before any other beforeSendEvent listener. Never throws.
export const selfReportIntegration = {
  name: "SelfReportAllowList",
  setup(client) {
    client.on("beforeSendEvent", (event, hint) => {
      let own = true;
      try {
        own = hint?.data?.__sentry__ === true;
      } catch { /* unreadable: treat as the SDK's own */ }
      if (!own) return;
      try { selfReports.add(event); } catch { /* not an object: nothing to rebuild */ }
    });
  },
};

// True for the breadcrumb the SDK records about its own report (the browser's
// `sentry.event` crumb), or one whose hint cannot be read: both are dropped.
export function isSelfReportBreadcrumb(hint) {
  try {
    const event = hint?.event;
    return event !== null && typeof event === "object" && selfReports.has(event);
  } catch {
    return true;
  }
}
