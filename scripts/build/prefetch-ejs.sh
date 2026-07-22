#!/bin/bash
# Pre-fetch yt-dlp EJS challenge solver modules from GitHub. Called
# from the Dockerfile at build time so the cached JS modules ship
# inside the image layer (at /home/node/.cache/yt-dlp/ejs) and the
# runtime gateway never needs GitHub access.
set -u

OUT_TPL='/tmp/__yt_probe.%(ext)s'
trap 'rm -f /tmp/__yt_probe.*' EXIT

yt-dlp \
    --remote-components ejs:github \
    -f worst \
    --no-warnings \
    -o "$OUT_TPL" \
    "https://www.youtube.com/watch?v=jNQXAC9IVRw" \
    2>&1 | tail -10
