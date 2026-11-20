#!/usr/bin/env bash
# Planned restart of one process started by scripts/up.sh, without Ctrl-C of the
# whole stack. api and web are replaced at once; worker starts a new process first
# and drains the old one (SIGUSR2) so jobs in hand finish.
#
# Usage: scripts/restart.sh api|web|worker
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  api | web | worker) ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "usage: scripts/restart.sh api|web|worker" >&2
    exit 2
    ;;
esac

afk_home="${AFK_HOME:-$HOME/.afk}"
run_dir="$afk_home/run"
up_pid_file="$run_dir/up.pid"

up_running() {
  local pid
  [ -f "$up_pid_file" ] || return 1
  pid=$(tr -d ' \n' <"$up_pid_file")
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

if ! up_running; then
  echo "no up.sh is running; start the stack first: scripts/up.sh" >&2
  exit 1
fi

target=$1
pidfile="$run_dir/$target.pid"
if [ ! -f "$pidfile" ]; then
  echo "scripts/restart.sh: $target is not running" >&2
  exit 1
fi

old_pid=$(tr -d ' \n' <"$pidfile")

if ! cmp -s pnpm-lock.yaml node_modules/.pnpm/lock.yaml 2>/dev/null; then
  echo "dependencies do not match pnpm-lock.yaml; running pnpm install --frozen-lockfile" >&2
  if ! pnpm install --frozen-lockfile; then
    echo "pnpm install --frozen-lockfile failed; leaving running processes unchanged" >&2
    exit 1
  fi
fi

# up.sh applies migrations before it replaces the API; that can take a while, and when it fails up.sh leaves the
# old API running and writes why to restart.failed.
failed="$run_dir/restart.failed"
rm -f "$failed"
printf '%s\n' "$target" >"$run_dir/restart.request"
n=0
while [ "$n" -lt 600 ]; do
  new_pid=$(tr -d ' \n' <"$pidfile" 2>/dev/null || true)
  if [ -n "$new_pid" ] && [ "$new_pid" != "$old_pid" ] && kill -0 "$new_pid" 2>/dev/null; then
    exit 0
  fi
  if [ -f "$failed" ]; then
    cat "$failed" >&2
    rm -f "$failed"
    exit 1
  fi
  sleep 0.2
  n=$((n + 1))
done
echo "scripts/restart.sh: timed out waiting for $target to restart" >&2
exit 1
