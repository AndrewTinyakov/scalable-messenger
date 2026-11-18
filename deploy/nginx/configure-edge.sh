#!/bin/sh
set -eu
case "${MESSENGER_PUBLIC_SCHEME:-http}" in
  http) public_scheme=http; public_port=80; hsts='' ;;
  https) public_scheme=https; public_port=443; hsts='max-age=31536000' ;;
  *) echo 'MESSENGER_PUBLIC_SCHEME must be http or https' >&2; exit 1 ;;
esac
case "${MESSENGER_CONNECTION_LIMIT:-200}" in
  ''|*[!0-9]*) echo 'MESSENGER_CONNECTION_LIMIT must be an integer' >&2; exit 1 ;;
esac
{
  printf '%s\n' 'real_ip_header X-Forwarded-For;' 'real_ip_recursive on;'
  for cidr in ${MESSENGER_TRUSTED_PROXY_CIDRS:-} ${MESSENGER_FRONT_PROXY_CIDR:-}; do
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
} > /etc/nginx/conf.d/trusted-proxies.inc
cat > /etc/nginx/conf.d/proxy-headers.inc <<HEADERS
proxy_set_header Host \$http_host;
proxy_set_header X-Real-IP \$remote_addr;
proxy_set_header X-Forwarded-For \$remote_addr;
proxy_set_header X-Forwarded-Proto $public_scheme;
proxy_set_header X-Forwarded-Host \$http_host;
proxy_set_header X-Forwarded-Port $public_port;
proxy_set_header Forwarded "";
HEADERS
cat > /etc/nginx/conf.d/edge-security.inc <<SECURITY
client_header_timeout 10s;
client_body_timeout 10s;
send_timeout 30s;
client_max_body_size 32k;
limit_conn messenger_connections ${MESSENGER_CONNECTION_LIMIT:-200};
limit_conn_status 429;
add_header Strict-Transport-Security "$hsts" always;
SECURITY
