#!/bin/bash
# Pre-fetch yt-dlp EJS challenge solver modules from GitHub. Called
# from the Dockerfile at build time so the cached JS modules ship
# inside the image layer (at /home/node/.cache/yt-dlp/ejs) and the
# runtime gateway never needs GitHub access.
#
# Note: yt-dlp does NOT inherit HTTP_PROXY from the parent by default —
# we must pass --proxy explicitly.
set -u

OUT_TPL='/tmp/__yt_probe.%(ext)s'
trap 'rm -f /tmp/__yt_probe.*' EXIT

PROXY_ARG=""
if [[ -n "${HTTP_PROXY:-}" || -n "${HTTPS_PROXY:-}" ]]; then
    PROXY="${HTTPS_PROXY:-${HTTP_PROXY:-}}"
    PROXY_ARG="--proxy ${PROXY}"
fi

yt-dlp \
    --remote-components ejs:github \
    -f worst \
    --no-warnings \
    ${PROXY_ARG} \
    -o "$OUT_TPL" \
    "https://www.youtube.com/watch?v=jNQXAC9IVRw" \
    2>&1 | tail -10
