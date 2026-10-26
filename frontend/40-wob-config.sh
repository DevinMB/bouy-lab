#!/bin/sh
# Runs from the nginx image's entrypoint before nginx starts: writes the runtime
# config the frontend reads (window.__WOB_CONFIG__). The CARTO key is a
# browser-side tile key, so it is public by nature; it just isn't baked in.
set -eu
key=$(printf '%s' "${CARTO_API_KEY:-}" | sed 's/[\\"]/\\&/g')
printf 'window.__WOB_CONFIG__ = {"cartoKey": "%s"};\n' "$key" > /usr/share/nginx/html/config.js
