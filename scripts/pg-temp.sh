#!/usr/bin/env bash
# Throwaway Postgres for tests, for machines without Docker (sandbox) or without compose.
# Usage: scripts/pg-temp.sh start|stop   (start prints the DATABASE_URL to use)
# Durability is off (fsync, full-page writes): the data is thrown away, and CREATE DATABASE, which every test
# does, is ten times faster without it.
# Env: PGTEMP_DIR (default /tmp/afk-pg), PGTEMP_PORT (default 54329)
set -euo pipefail

dir="${PGTEMP_DIR:-/tmp/afk-pg}"
port="${PGTEMP_PORT:-54329}"
bin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
[ -n "$bin" ] || bin="$(dirname "$(command -v pg_ctl)")"

# Postgres refuses to run as root; drop to the postgres user when we are root.
as_pg() { if [ "$(id -u)" = 0 ]; then runuser -u postgres -- "$@"; else "$@"; fi; }

case "${1:-}" in
  start)
    if [ ! -d "$dir/data" ]; then
      mkdir -p "$dir"
      [ "$(id -u)" = 0 ] && chown postgres "$dir"
      as_pg "$bin/initdb" -D "$dir/data" -U afk --auth=trust --locale=C.UTF-8 >/dev/null
    fi
    if ! as_pg "$bin/pg_isready" -h 127.0.0.1 -p "$port" >/dev/null; then
      as_pg "$bin/pg_ctl" -D "$dir/data" -o "-p $port -k $dir -c listen_addresses=127.0.0.1 -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=300" \
        -l "$dir/log" -w start >/dev/null
    fi
    as_pg "$bin/psql" -h 127.0.0.1 -p "$port" -U afk -d postgres -tAc \
      "SELECT 1 FROM pg_database WHERE datname='afk'" | grep -q 1 \
      || as_pg "$bin/createdb" -h 127.0.0.1 -p "$port" -U afk afk
    echo "export DATABASE_URL=postgres://afk@127.0.0.1:$port/afk"
    ;;
  stop)
    as_pg "$bin/pg_ctl" -D "$dir/data" -m fast stop >/dev/null
    ;;
  *)
    echo "usage: $0 start|stop" >&2
    exit 2
    ;;
esac
