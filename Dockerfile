# Node 22 (not 20): @supabase/realtime-js >=2.108 hard-throws on Node <22 without
# native WebSocket ("Node.js 20 detected without native WebSocket support"), crashing
# the server at supabase createClient on boot. Node 22 ships a native WebSocket global.
# package.json engines already allows >=21.0.0. (RR7 prod outage 2026-06-14.)
FROM node:22-alpine

EXPOSE 3000

WORKDIR /app

ENV NODE_ENV=production

COPY package.json package-lock.json* ./

RUN npm ci --omit=dev && npm cache clean --force
# Remove CLI packages since we don't need them in production by default.
# Remove this line if you want to run CLI commands in your container.
RUN npm remove @shopify/cli

COPY . .

# Sentry server source-map upload during the build.
#  - SENTRY_ORG / SENTRY_PROJECT / SENTRY_RELEASE are non-secret build ARGs (slugs +
#    git short SHA). SENTRY_RELEASE is passed explicitly because node:22-alpine has no
#    git CLI, so the bundler plugin can't auto-detect HEAD's SHA in the container.
#  - SENTRY_AUTH_TOKEN is a BUILD SECRET, mounted only for this RUN via
#    --mount=type=secret. It is read into the env for the upload and never persists in
#    any image layer. Pass it at deploy time with:
#      fly deploy --build-secret sentry_auth_token=$SENTRY_AUTH_TOKEN
#    When the secret is absent (local `docker build`, CI), the token is empty and
#    vite.config.ts disables the upload — the build still succeeds.
ARG SENTRY_ORG
ARG SENTRY_PROJECT
ARG SENTRY_RELEASE
# The Sentry env is scoped to this single RUN (not a Dockerfile-wide ENV), so none of
# the slugs, the release, or the token linger in the final image / runtime.
RUN --mount=type=secret,id=sentry_auth_token \
    SENTRY_ORG="$SENTRY_ORG" \
    SENTRY_PROJECT="$SENTRY_PROJECT" \
    SENTRY_RELEASE="$SENTRY_RELEASE" \
    SENTRY_AUTH_TOKEN="$(cat /run/secrets/sentry_auth_token 2>/dev/null || true)" \
    npm run build

# `npm run start` carries NODE_OPTIONS='--import ./instrument.server.mjs' inline so Sentry
# (with the HIPAA scrubbing) initializes before the RR7 server bundle loads. It is scoped to
# the start script — NOT a Dockerfile-wide ENV — so it never runs during `npm run build` above.
CMD ["npm", "run", "start"]
