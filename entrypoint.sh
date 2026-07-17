#!/bin/sh
# Container entrypoint (root). Ensures the gateway log dir is writable by the
# 'node' user even when /var/log/gateway is a bind mount (host dirs come in
# root-owned, masking the Dockerfile chown), then hands off to supervisord.
set -e
mkdir -p /var/log/gateway
chown -R node:node /var/log/gateway || true
exec supervisord -c /etc/supervisor/conf.d/supervisord.conf
