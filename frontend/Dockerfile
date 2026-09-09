FROM node:20-slim AS builder

WORKDIR /app

COPY package.json .
RUN npm install

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
