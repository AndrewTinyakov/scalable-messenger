#!/bin/sh
set -eu

fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

scheme_of() { printf '%s' "${1%%://*}"; }
host_of() {
  rest=${1#*://}
  printf '%s' "${rest%%/*}"
}
path_of() {
  rest=${1#*://}
  case "$rest" in */*) printf '/%s' "${rest#*/}" ;; esac
}

require_url() {
  url=$1
  shift
  case "$url" in *://*) ;; *) fail 'Invalid Messenger transport URL' ;; esac
  case "$url" in *[!A-Za-z0-9.:/_~%-]*) fail 'Invalid Messenger transport URL' ;; esac
  [ -n "$(host_of "$url")" ] || fail 'Invalid Messenger transport URL'
  scheme=$(scheme_of "$url")
  for allowed in "$@"; do
    [ "$scheme" = "$allowed" ] && return 0
  done
  fail 'Invalid Messenger transport URL'
}

api=${MESSENGER_API_BASE_URL:?Set MESSENGER_API_BASE_URL}
ws=${MESSENGER_WS_URL:?Set MESSENGER_WS_URL}
api=${api%/}
require_url "$api" http https
require_url "$ws" ws wss
api_scheme=$(scheme_of "$api")
ws_scheme=$(scheme_of "$ws")
case "$api_scheme:$ws_scheme" in
  https:wss | http:ws) ;;
  *) fail 'HTTPS and WSS must be used together' ;;
esac
if [ "${MESSENGER_PUBLIC_SCHEME:-http}" = https ] && [ "$api_scheme" != https ]; then
  fail 'An HTTPS deployment requires HTTPS and WSS URLs'
fi
if [ "${MESSENGER_PRODUCTION:-false}" = true ]; then
  origin=${MESSENGER_CLIENT_ORIGIN:?Set MESSENGER_CLIENT_ORIGIN}
  require_url "$origin" https
  host=$(host_of "$origin")
  if [ "$origin" != "https://$host" ] || [ "$api" != "$origin/api" ] || [ "$(host_of "$ws")" != "$host" ] || [ "$(path_of "$ws")" != /ws ]; then
    fail 'Production requires one exact HTTPS origin, API /api and WebSocket /ws'
  fi
fi

api_origin="$api_scheme://$(host_of "$api")"
ws_origin="$ws_scheme://$(host_of "$ws")"
sed -e "s|__MESSENGER_API_ORIGIN__|$api_origin|g" -e "s|__MESSENGER_WS_ORIGIN__|$ws_origin|g" \
  "${MESSENGER_NGINX_TEMPLATE:-/opt/messenger/nginx.conf}" > "${1:-/etc/nginx/conf.d/default.conf}"
printf 'window.__MESSENGER_CONFIG__={"apiBaseUrl":"%s","wsUrl":"%s"};\n' "$api" "$ws" > "${2:-/var/run/runtime-config.js}"
