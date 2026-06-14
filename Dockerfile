FROM node:20-alpine

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
