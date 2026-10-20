import type { Config } from "@react-router/dev/config";
import { sentryOnBuildEnd } from "@sentry/react-router";

export default {
  ssr: true,
  // Fly terminates TLS and react-router-serve sets no `trust proxy`, so request.url
  // is http:// while the admin iframe's Origin is https://. The CSRF check compares
  // the two and refused every admin action 400 (US-51 AC1). It matches the Origin's
  // host only; these are the two apps' own hosts. Never a wildcard, never localhost.
  allowedActionOrigins: ["health-tool-app.fly.dev", "health-tool-edu.fly.dev"],
  buildEnd: async ({ viteConfig, reactRouterConfig, buildManifest }) => {
    await sentryOnBuildEnd({ viteConfig, reactRouterConfig, buildManifest });
  },
} satisfies Config;
