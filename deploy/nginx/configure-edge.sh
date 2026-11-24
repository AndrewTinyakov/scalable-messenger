#!/bin/sh
set -eu
conf=${MESSENGER_NGINX_CONF_DIR:-/etc/nginx/conf.d}
case "${MESSENGER_PUBLIC_SCHEME:-http}" in
  http) public_scheme=http; public_port=80; hsts='' ;;
  https) public_scheme=https; public_port=443; hsts='max-age=31536000' ;;
  *) echo 'MESSENGER_PUBLIC_SCHEME must be http or https' >&2; exit 1 ;;
esac
case "${MESSENGER_CONNECTION_LIMIT:-200}" in
  ''|*[!0-9]*) echo 'MESSENGER_CONNECTION_LIMIT must be an integer' >&2; exit 1 ;;
esac
origin=${MESSENGER_CLIENT_ORIGIN:-}
if [ -n "$origin" ]; then
  case "$origin" in
    http://?*|https://?*) ;;
    *) echo 'MESSENGER_CLIENT_ORIGIN must be an exact HTTP or HTTPS origin' >&2; exit 1 ;;
  esac
  case "${origin#*://}" in
    *[!a-z0-9.:-]*|.*|*:|*::*) echo 'MESSENGER_CLIENT_ORIGIN must be an exact lowercase origin without a path' >&2; exit 1 ;;
  esac
  if [ "$public_scheme" = https ] && [ "${origin%%://*}" != https ]; then
    echo 'An HTTPS deployment requires an HTTPS MESSENGER_CLIENT_ORIGIN' >&2
    exit 1
  fi
fi
{
  printf '%s\n' 'real_ip_header X-Forwarded-For;' 'real_ip_recursive on;'
  for cidr in ${MESSENGER_TRUSTED_PROXY_CIDRS:-}; do
    case "$cidr" in
      *[!0-9a-fA-F:./]*) echo 'Trusted proxies must be space-separated IP CIDRs' >&2; exit 1 ;;
    esac
    case "$cidr" in
      */*)
        prefix=${cidr##*/}
        case "$cidr" in *:*) minimum=32 ;; *) minimum=8 ;; esac
        case "$prefix" in ''|*[!0-9]*) echo 'Trusted proxy prefix must be a number' >&2; exit 1 ;; esac
        if [ "$prefix" -lt "$minimum" ]; then
          echo "Trusted proxy range $cidr is too broad; clients could spoof their address" >&2
          exit 1
        fi
        ;;
    esac
    printf 'set_real_ip_from %s;\n' "$cidr"
  done
} > "$conf/trusted-proxies.inc"
{
  printf '%s\n' 'map $http_origin $messenger_cors_origin {' '    default "";'
  if [ -n "$origin" ]; then printf '    "%s" "%s";\n' "$origin" "$origin"; fi
  printf '%s\n' '}' 'map $messenger_cors_origin $messenger_cors_credentials {' '    "" "";' '    default true;' '}'
} > "$conf/client-origin.inc"
cat > "$conf/proxy-headers.inc" <<HEADERS
proxy_set_header Host \$http_host;
proxy_set_header X-Real-IP \$remote_addr;
proxy_set_header X-Forwarded-For \$remote_addr;
proxy_set_header X-Forwarded-Proto $public_scheme;
proxy_set_header X-Forwarded-Host \$http_host;
proxy_set_header X-Forwarded-Port $public_port;
proxy_set_header Forwarded "";
HEADERS
cat > "$conf/edge-headers.inc" <<HEADERS
add_header Strict-Transport-Security "$hsts" always;
add_header X-Content-Type-Options nosniff always;
add_header Referrer-Policy no-referrer always;
HEADERS
cat > "$conf/edge-security.inc" <<SECURITY
client_header_timeout 10s;
client_body_timeout 10s;
send_timeout 30s;
client_max_body_size 32k;
limit_conn messenger_connections ${MESSENGER_CONNECTION_LIMIT:-200};
limit_conn_status 429;
include $conf/edge-headers.inc;
SECURITY
