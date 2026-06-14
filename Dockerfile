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

RUN npm run build

# `npm run start` carries NODE_OPTIONS='--import ./instrument.server.mjs' inline so Sentry
# (with the HIPAA scrubbing) initializes before the RR7 server bundle loads. It is scoped to
# the start script — NOT a Dockerfile-wide ENV — so it never runs during `npm run build` above.
CMD ["npm", "run", "start"]
