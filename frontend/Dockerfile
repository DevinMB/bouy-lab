FROM node:22.23.3-slim AS builder

WORKDIR /app

# Install from the committed lockfile. Without one, every build resolved
# whatever the registry served that day -- which is how a dependency published
# around 2026-10-20 began crashing npm 10's peer resolver ("Cannot read
# properties of null (reading 'edgesOut')") and broke the build overnight. npm 11
# carries the resolver fix; `npm ci` makes the build reproducible.
COPY package.json package-lock.json ./
RUN npx -y npm@11 ci

COPY . .
RUN npm run build

FROM nginx:1.31.0-alpine
# Alpine security fixes land between base image releases; CI's Trivy gate
# fails on fixable HIGH and CRITICAL findings.
RUN apk upgrade --no-cache
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
# Writes /config.js from CARTO_API_KEY at start, so the image carries no key and
# changing it needs a restart, not a rebuild.
COPY 40-wob-config.sh /docker-entrypoint.d/40-wob-config.sh
ARG COMMIT=unknown
ENV COMMIT=$COMMIT
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1/ >/dev/null || exit 1
