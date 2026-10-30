#!/usr/bin/env bash
# Helper for the interruption drills (#42), run on the Mac next to `pnpm worker`.
#   scripts/drill.sh jobs                  the latest jobs: id, type, state, lease owner, lease expiry, attempt
#   scripts/drill.sh kill <type>           wait until a <type> job is running, then SIGKILL the worker
#   scripts/drill.sh freeze <type>         the same, but SIGSTOP: the worker is frozen, not dead (wake it with: scripts/drill.sh wake)
#   scripts/drill.sh wake                  SIGCONT the frozen worker
#   scripts/drill.sh kill-committed        wait until the agent has committed in a slot, then SIGKILL the worker (the slot-salvage drill)
#   scripts/drill.sh freeze-committed      the same, but SIGSTOP: the agent's result is still to be pushed when the worker wakes (drill 4)
# <type> is agent-run, gate or merge. Needs Postgres from compose.yaml (docker compose) and lsof.
# DRILL_DB (default afk) is the database of the API under test; DRILL_HOME (default ~/.afk) is the worker's AFK_HOME.
set -euo pipefail
cd "$(dirname "$0")/.."

sql() { docker compose exec -T postgres psql -U afk -d "${DRILL_DB:-afk}" -tA -c "$1"; }

worker_pid() {
  local pid
  for pid in $(pgrep -f 'node src/main.ts' || true); do
    if lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -q 'packages/worker$'; then
      echo "$pid"
      return
    fi
  done
  echo "no worker process found" >&2
  return 1
}

wait_for() {
  until [ -n "$(sql "SELECT 1 FROM jobs WHERE state = 'running' AND type = '$1' LIMIT 1")" ]; do sleep 0.5; done
}

# the first slot clone with a commit the main clone's default branch does not have; prints its path
committed_worktree() {
  local wt
  for wt in "${DRILL_HOME:-$HOME/.afk}"/slots/*/*/.sandcastle/worktrees/*; do
    [ -d "$wt" ] || continue
    if [ "$(git -C "$wt" rev-list --count HEAD ^origin/main 2>/dev/null || echo 0)" -gt 0 ]; then
      echo "$wt"
      return
    fi
  done
  return 1
}

case "${1:-}" in
  jobs)
    sql "SELECT id, type, state, lease_owner, to_char(lease_expires_at, 'HH24:MI:SS') AS lease_until, attempt FROM jobs ORDER BY id DESC LIMIT 8"
    ;;
  kill | freeze)
    type="${2:?usage: scripts/drill.sh $1 agent-run|gate|merge}"
    pid="$(worker_pid)"
    echo "waiting for a running $type job (worker pid $pid)..."
    wait_for "$type"
    if [ "$1" = kill ]; then kill -KILL "$pid"; else kill -STOP "$pid"; fi
    echo "$1 sent to $pid at $(date +%T); a $type job was running:"
    sql "SELECT id, type, state, lease_owner, attempt FROM jobs WHERE state = 'running'"
    ;;
  kill-committed | freeze-committed)
    pid="$(worker_pid)"
    echo "waiting for the agent to commit in a slot (worker pid $pid)..."
    until wt="$(committed_worktree)"; do sleep 0.2; done
    if [ "$1" = kill-committed ]; then kill -KILL "$pid"; else kill -STOP "$pid"; fi
    echo "${1%-committed} sent to $pid at $(date +%T); the agent had committed in $wt:"
    git -C "$wt" log --oneline origin/main..HEAD
    sql "SELECT id, type, state, lease_owner, attempt FROM jobs WHERE state = 'running'"
    ;;
  wake)
    pid="$(worker_pid)"
    kill -CONT "$pid"
    echo "woke $pid at $(date +%T)"
    ;;
  *)
    sed -n 2,8p "$0"
    exit 2
    ;;
esac
