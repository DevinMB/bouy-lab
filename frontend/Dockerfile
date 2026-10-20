FROM node:20-slim AS builder

WORKDIR /app

# Install from the committed lockfile. Without one, every build resolved
# whatever the registry served that day -- which is how a dependency published
# around 2026-10-20 began crashing npm 10.8's peer resolver ("Cannot read
# properties of null (reading 'edgesOut')") and broke the build overnight. npm 11
# carries the resolver fix; `npm ci` makes the build reproducible.
COPY package.json package-lock.json ./
RUN npx -y npm@11 ci

COPY . .

# CARTO basemap key — Vite inlines VITE_* env vars at build time.
ARG VITE_CARTO_API_KEY=
ENV VITE_CARTO_API_KEY=$VITE_CARTO_API_KEY
RUN npm run build

FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
