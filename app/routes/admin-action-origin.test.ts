// US-51 AC1: an embedded-admin form POST reaches its action behind Fly's TLS
// termination. react-router-serve builds request.url as http:// (no `trust proxy`),
// while the admin iframe's Origin is https://<app>.fly.dev, so react-router's CSRF
// check answered every admin action 400 (Sentry 7803370248, 2026-10-21). The two app
// hosts are listed in react-router.config.ts `allowedActionOrigins`; every other
// origin, localhost included, still gets 400.
import { describe, expect, it } from "vitest";
import { createRequestHandler, type ServerBuild } from "react-router";

import config from "../../react-router.config";

let actionRuns = 0;

function buildWith(allowedActionOrigins: string[] | undefined): ServerBuild {
  const noop = () => null;
  return {
    entry: { module: { default: () => new Response("doc") } },
    routes: {
      root: { id: "root", path: "", module: { default: noop } },
      "routes/app.trending-test": {
        id: "routes/app.trending-test",
        parentId: "root",
        path: "app/trending-test",
        module: {
          default: noop,
          action: async () => {
            actionRuns++;
            return { ok: true };
          },
        },
      },
    },
    assets: { routes: {}, entry: { module: "", imports: [] }, url: "", version: "" },
    publicPath: "/",
    assetsBuildDirectory: "",
    future: {},
    ssr: true,
    isSpaMode: false,
    prerender: [],
    routeDiscovery: { mode: "lazy", manifestPath: "/__manifest" },
    allowedActionOrigins,
  } as unknown as ServerBuild;
}

// What react-router-serve hands react-router on Fly: http scheme, the app's own host.
async function postFromOrigin(host: string, origin: string | null) {
  const handler = createRequestHandler(buildWith(config.allowedActionOrigins), "production");
  const headers = new Headers({ "content-type": "application/x-www-form-urlencoded" });
  if (origin) headers.set("origin", origin);
  const before = actionRuns;
  const res = await handler(
    new Request(`http://${host}/app/trending-test.data`, { method: "POST", headers, body: "" }),
  );
  return { status: res.status, ran: actionRuns > before };
}

describe("US-51 AC1: admin actions behind Fly's TLS proxy", () => {
  it("lists exactly the two app hosts, no wildcard, no localhost", () => {
    expect(config.allowedActionOrigins).toEqual([
      "health-tool-app.fly.dev",
      "health-tool-edu.fly.dev",
    ]);
  });

  for (const host of ["health-tool-app.fly.dev", "health-tool-edu.fly.dev"]) {
    it(`a POST from https://${host} to http://${host} runs the action`, async () => {
      const { status, ran } = await postFromOrigin(host, `https://${host}`);
      expect(ran).toBe(true);
      expect(status).toBe(200);
    });
  }

  it("a POST with no Origin still runs (same as before)", async () => {
    expect((await postFromOrigin("health-tool-app.fly.dev", null)).ran).toBe(true);
  });

  for (const origin of [
    "https://evil.example",
    "https://health-tool-app.fly.dev.evil.example",
    "https://evil.fly.dev",
    "http://localhost:3000",
    "https://admin.shopify.com",
    "null",
  ]) {
    it(`a POST from ${origin} is refused 400 before the action`, async () => {
      const { status, ran } = await postFromOrigin("health-tool-app.fly.dev", origin);
      expect(ran).toBe(false);
      expect(status).toBe(400);
    });
  }
});
