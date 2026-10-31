#!/usr/bin/env bash
# One command for the four processes of "Run it on this machine (Mac)" in the README:
# Postgres (compose), migrations, the API, the page and one worker, with their output on one terminal.
# Usage: AFK_MODEL=<cursor model> scripts/up.sh      (Ctrl-C stops everything; Ctrl-C twice: exit at once)
# Env: AFK_MODEL (required), DATABASE_URL (default the compose database), PORT (API, default 3000),
#      AFK_SKILLS_DIR (default ~/.afk/skills/skills/engineering), WEB=0 or WORKER=0 to leave that one out.
# The worker's own settings (AFK_HOME, AFK_SLOTS, AFK_SANDBOX_IMAGE, ...) are passed through as they are.
set -euo pipefail
cd "$(dirname "$0")/.."
set -m # every pipeline below gets its own process group, so Ctrl-C reaches only what we forward it to

export DATABASE_URL="${DATABASE_URL:-postgres://afk:afk@localhost:5432/afk}"
export PORT="${PORT:-3000}"
export AFK_API_URL="${AFK_API_URL:-http://127.0.0.1:$PORT}"
export AFK_SKILLS_DIR="${AFK_SKILLS_DIR:-$HOME/.afk/skills/skills/engineering}"

if [ "${WORKER:-1}" != 0 ]; then
  problems=()
  [ -n "${AFK_MODEL:-}" ] || problems+=("AFK_MODEL is not set: the Cursor model the agents use")
  [ -d "$AFK_SKILLS_DIR" ] || problems+=("AFK_SKILLS_DIR $AFK_SKILLS_DIR is not a directory (README: a checkout of mattpocock/skills)")
  [ -n "${CURSOR_API_KEY:-}" ] || grep -qs '^CURSOR_API_KEY=' "$HOME/.afk/env" || problems+=("CURSOR_API_KEY is neither exported nor in ~/.afk/env")
  if [ "${#problems[@]}" -gt 0 ]; then
    printf 'cannot start: %s\n' "${problems[@]}" >&2
    exit 1
  fi
fi

pgids=() # process groups, started order
names=()

# start <name> <command...>: run it in the background with every output line prefixed by the name
start() {
  local name=$1
  shift
  "$@" 2>&1 | sed -u "s/^/[$name] /" &
  pgids+=("$(ps -o pgid= -p "$!" | tr -d ' ')")
  names+=("$name")
}

stopping=0
stop_all() {
  [ "$stopping" = 0 ] || return 0
  stopping=1
  trap - INT TERM
  echo "stopping (the worker aborts the runs in hand first)..."
  local i
  # reverse order: worker, then page, then API
  for ((i = ${#pgids[@]} - 1; i >= 0; i--)); do
    kill -INT -- "-${pgids[i]}" 2>/dev/null || true
    # the worker needs a moment to abort its runs; the others stop at once
    if [ "${names[i]}" = worker ]; then wait_group "${pgids[i]}"; fi
  done
  wait 2>/dev/null || true
}

wait_group() {
  local n=0
  while kill -0 -- "-$1" 2>/dev/null && [ "$n" -lt 120 ]; do
    sleep 0.5
    n=$((n + 1))
  done
}
trap stop_all INT TERM EXIT

docker compose up -d --wait postgres
pnpm db:migrate

start api pnpm api
until curl -s -o /dev/null "$AFK_API_URL/"; do
  if ! kill -0 -- "-${pgids[0]}" 2>/dev/null; then
    echo "the API stopped before it came up" >&2
    exit 1
  fi
  sleep 0.5
done

[ "${WEB:-1}" = 0 ] || start web pnpm web
[ "${WORKER:-1}" = 0 ] || start worker pnpm worker

echo "up: API $AFK_API_URL, page http://127.0.0.1:5173 (Postgres stays up when you stop; docker compose stop postgres to stop it)"

# leave as soon as any process dies, then stop the rest (macOS bash 3.2 has no `wait -n`)
while :; do
  for i in "${!pgids[@]}"; do
    if ! kill -0 -- "-${pgids[i]}" 2>/dev/null; then
      echo "${names[i]} exited; stopping the rest" >&2
      exit 1
    fi
  done
  sleep 1
done
