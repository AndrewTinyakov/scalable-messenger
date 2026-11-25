FROM alpine:3.22
RUN apk add --no-cache pgbouncer=1.24.0-r0 \
    && addgroup -S -g 6432 pgbouncer \
    && adduser -S -u 6432 -G pgbouncer -H -s /sbin/nologin pgbouncer \
    && install -d -o pgbouncer -g pgbouncer -m 0700 /run/pgbouncer
COPY entrypoint.sh /usr/local/bin/pgbouncer-entrypoint
USER pgbouncer
EXPOSE 6432
ENTRYPOINT ["/usr/local/bin/pgbouncer-entrypoint"]
