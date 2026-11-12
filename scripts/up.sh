#!/usr/bin/env bash
# One command for the four processes of "Run it on this machine (Mac)" in the README:
# Postgres (compose), migrations, the API, the page and one worker, with their output on one terminal.
# The first time, it checks what the README's "Once" list asks for and, in a terminal, offers to do each
# missing step for you (install dependencies, build the sandbox image, save your
# model and Cursor key to ~/.afk/env, write a GitLab PAT). Without a terminal it only lists what is missing
# and how to fix it. Code-host credentials are at least one of the GitHub App or a GitLab PAT
# (~/.afk/secrets/gitlab/<host>, mode 600, verified against that host). --check never asks.
#
# Usage: scripts/up.sh            (Ctrl-C stops everything; Ctrl-C twice: stop them at once)
#        scripts/up.sh --check    only check, start nothing
# Settings are read from the environment first, then from ~/.afk/env (the file the worker reads
# CURSOR_API_KEY from): AFK_MODEL (the Cursor model), CURSOR_API_KEY. Also: DATABASE_URL (default the compose database), PORT (API, default 3000),
# WEB=0 or WORKER=0 to leave that one out. The worker's own settings (AFK_HOME, AFK_SLOTS,
# AFK_SANDBOX_IMAGE, ...) are passed through as they are.
set -euo pipefail
cd "$(dirname "$0")/.."

check_only=0
case "${1:-}" in
  "") ;;
  --check) check_only=1 ;;
  -h | --help)
    sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
    exit 0
    ;;
  *)
    echo "usage: scripts/up.sh [--check]" >&2
    exit 2
    ;;
esac

export DATABASE_URL="${DATABASE_URL:-postgres://afk:afk@localhost:5432/afk}"
export PORT="${PORT:-3000}"
export AFK_API_URL="${AFK_API_URL:-http://127.0.0.1:$PORT}"

afk_home="${AFK_HOME:-$HOME/.afk}"
env_file="$afk_home/env"
image="${AFK_SANDBOX_IMAGE:-sandcastle:afk-platform}"

interactive=0
if [ -t 0 ] && [ -t 1 ]; then interactive=1; fi

# ── settings: the environment, then ~/.afk/env ────────────────────────────────────────────────────────
# NAME=value lines the way the worker reads them (an `export ` and one pair of quotes are allowed). The
# file holds the Cursor key, so it is parsed, never sourced.
file_setting() {
  [ -f "$env_file" ] || return 0
  sed -n -e "s/^[[:space:]]*\(export[[:space:]][[:space:]]*\)\{0,1\}$1[[:space:]]*=[[:space:]]*//p" "$env_file" |
    tail -n 1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'\$/\1/"
}
setting() {
  if [ -n "${!1:-}" ]; then printf '%s' "${!1}"; else file_setting "$1"; fi
}
# save_setting NAME VALUE: replace the NAME line of ~/.afk/env (or add it); other lines stay; mode 600
save_setting() {
  mkdir -p "$(dirname "$env_file")"
  local tmp
  tmp="$(mktemp "$env_file.XXXXXX")"
  if [ -f "$env_file" ]; then
    grep -v -E "^[[:space:]]*(export[[:space:]]+)?$1[[:space:]]*=" "$env_file" >"$tmp" || true
  fi
  printf '%s=%s\n' "$1" "$2" >>"$tmp"
  chmod 600 "$tmp"
  mv "$tmp" "$env_file"
}

# ── the checks ────────────────────────────────────────────────────────────────────────────────────────
problems=()
warnings=()
problem() { problems+=("$1"); }
good() { printf '  [ok] %s\n' "$1"; }
# both ways to put code-host credentials on this machine (GitHub App or a GitLab PAT)
no_host_credentials() {
  problem "No GitHub App credentials. Put private-key.pem and app.json in $1, then: chmod 600 $1/private-key.pem"
  problem "No GitLab token. Put a PAT in $2/<host> and run: chmod 600 $2/<host>"
}

# offer <question> <command...>: in a terminal, ask and run it; succeeds only if it was asked, said yes and worked
offer() {
  [ "$interactive" = 1 ] || return 1
  local question=$1 answer
  shift
  read -r -p "  $question [Y/n] " answer || return 1
  case "$answer" in "" | y | Y | yes | YES) ;; *) return 1 ;; esac
  "$@"
}

build_image() {
  docker build -t "$image" --build-arg "AGENT_UID=$(id -u)" --build-arg "AGENT_GID=$(id -g)" \
    -f .sandcastle/Dockerfile .sandcastle
}
build_image_cmd="docker build -t $image --build-arg AGENT_UID=\$(id -u) --build-arg AGENT_GID=\$(id -g) -f .sandcastle/Dockerfile .sandcastle"

echo "Checking this machine..."

docker_ok=0
if ! command -v docker >/dev/null 2>&1; then
  problem "Docker is not installed. Install Docker Desktop, start it, and run this again."
elif ! docker info >/dev/null 2>&1; then
  problem "Docker is installed but not running. Start Docker Desktop, wait until it says it is running, and run this again."
else
  docker_ok=1
  good "Docker is running"
fi

node_ok=0
if ! command -v node >/dev/null 2>&1; then
  problem "Node is not installed (22.18 or newer). Install it: brew install node"
elif [ "$(node -p 'const [a, b] = process.versions.node.split(".").map(Number); a > 22 || (a === 22 && b >= 18)')" != true ]; then
  problem "Node $(node -v) is too old (22.18 or newer is needed). Upgrade it: brew upgrade node"
else
  node_ok=1
  good "Node $(node -v)"
fi

pnpm_ok=0
if ! command -v pnpm >/dev/null 2>&1; then
  problem "pnpm is not available. Turn it on with: corepack enable"
else
  pnpm_ok=1
  good "pnpm $(pnpm -v)"
fi

if [ "$node_ok" = 1 ] && [ "$pnpm_ok" = 1 ]; then
  if [ -d node_modules ]; then
    good "dependencies are installed"
  elif offer "Dependencies are not installed. Run pnpm install now?" pnpm install; then
    good "dependencies installed"
  else
    problem "Dependencies are not installed. Run: pnpm install"
  fi
fi

if [ "${WORKER:-1}" != 0 ]; then
  if [ "$docker_ok" = 1 ]; then
    if docker image inspect "$image" >/dev/null 2>&1; then
      good "sandbox image $image"
    elif offer "The sandbox image $image is not built. Build it now (a few minutes the first time)?" build_image; then
      good "sandbox image $image built"
    else
      problem "The sandbox image $image is not built. Build it with: $build_image_cmd"
    fi
  fi

  model="$(setting AFK_MODEL)"
  if [ -z "$model" ] && [ "$interactive" = 1 ]; then
    read -r -p "  Cursor model the agents use (AFK_MODEL, for example cursor-grok-4.6-xhigh; saved to $env_file): " model || model=
    if [ -n "$model" ]; then save_setting AFK_MODEL "$model"; fi
  fi
  if [ -z "$model" ]; then
    problem "AFK_MODEL is not set (the Cursor model the agents use). Run: echo 'AFK_MODEL=<model>' >> $env_file"
  else
    export AFK_MODEL="$model"
    good "model: $model"
  fi

  slots="$(setting AFK_SLOTS)"
  if [ -n "$slots" ]; then
    export AFK_SLOTS="$slots"
    good "worker slots: $slots"
  fi

  key="$(setting CURSOR_API_KEY)"
  if [ -z "$key" ] && [ "$interactive" = 1 ]; then
    read -r -s -p "  Cursor API key (CURSOR_API_KEY; input is hidden; saved to $env_file, mode 600): " key || key=
    echo
    if [ -n "$key" ]; then save_setting CURSOR_API_KEY "$key"; fi
  fi
  if [ -z "$key" ]; then
    problem "CURSOR_API_KEY is not set. Put CURSOR_API_KEY=<your key> in $env_file and run: chmod 600 $env_file"
  else
    good "Cursor API key (not shown)"
  fi
  key=

  app_dir="${AFK_GITHUB_APP_DIR:-$afk_home/secrets/github-app}"
  gitlab_dir="${AFK_GITLAB_DIR:-$afk_home/secrets/gitlab}"
  github_ok=0
  gitlab_files=0
  if [ -f "$app_dir/private-key.pem" ] && [ -f "$app_dir/app.json" ]; then
    github_ok=1
    good "GitHub App credentials in $app_dir"
  fi
  if [ -d "$gitlab_dir" ]; then
    for f in "$gitlab_dir"/*; do
      [ -f "$f" ] || continue
      gitlab_files=1
      if out=$(node scripts/check-gitlab-token.ts "$f" 2>&1); then
        good "$out"
      else
        problem "$out"
      fi
    done
  fi
  if [ "$github_ok" = 0 ] && [ "$gitlab_files" = 0 ]; then
    if [ "$check_only" = 1 ] || [ "$interactive" = 0 ]; then
      no_host_credentials "$app_dir" "$gitlab_dir"
    else
      kind=
      read -r -p "  Use a GitHub App or a GitLab token? [github/gitlab] " kind || kind=
      case "$kind" in
        github | GitHub | GITHUB)
          problem "No GitHub App credentials in $app_dir (private-key.pem and app.json). See the README, then check them with: node scripts/check-github-app.ts <owner>/<repo>"
          ;;
        gitlab | GitLab | GITLAB)
          gl_host=
          gl_token=
          read -r -p "  GitLab host (for example git.example.com; saved as $gitlab_dir/<host>): " gl_host || gl_host=
          read -r -s -p "  GitLab personal access token (input is hidden; saved mode 600): " gl_token || gl_token=
          echo
          gl_host=$(printf '%s' "$gl_host" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
          case "$gl_host" in
            "" | . | .. | */*)
              problem "GitLab host must be a hostname (the file name under $gitlab_dir)"
              ;;
            *)
              mkdir -p "$gitlab_dir"
              printf '%s\n' "$gl_token" >"$gitlab_dir/$gl_host"
              chmod 600 "$gitlab_dir/$gl_host"
              if out=$(node scripts/check-gitlab-token.ts "$gitlab_dir/$gl_host" 2>&1); then
                good "$out"
              else
                problem "$out"
              fi
              ;;
          esac
          ;;
        *)
          no_host_credentials "$app_dir" "$gitlab_dir"
          ;;
      esac
    fi
  fi
fi

if [ "${#warnings[@]}" -gt 0 ]; then
  printf '  [!!] %s\n' "${warnings[@]}"
fi
if [ "${#problems[@]}" -gt 0 ]; then
  echo
  echo "Cannot start yet. To fix:" >&2
  printf '  - %s\n' "${problems[@]}" >&2
  exit 1
fi
if [ "$check_only" = 1 ]; then
  echo "All checks passed."
  exit 0
fi
echo

# a server of this checkout (or anything else) already on a port would make the new one die while the
# readiness check below still sees the old one answer, and a second worker would join the first
busy=()
for port in "$PORT" $([ "${WEB:-1}" = 0 ] || echo 5173); do
  if [ -n "$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null)" ]; then busy+=("$port"); fi
done
if [ "${#busy[@]}" -gt 0 ]; then
  echo "cannot start: port ${busy[*]} already in use (is the stack already running? stop it first)" >&2
  exit 1
fi

set -m # every pipeline below gets its own process group, so Ctrl-C reaches only what we forward it to

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
  echo "stopping (the worker aborts the runs in hand first; Ctrl-C again stops them at once)..."
  local i
  # reverse order: worker, then page, then API
  for ((i = ${#pgids[@]} - 1; i >= 0; i--)); do
    kill -INT -- "-${pgids[i]}" 2>/dev/null || true
    # the worker needs a moment to abort its runs; the others stop at once
    if [ "${names[i]}" = worker ]; then wait_group "${pgids[i]}"; fi
  done
  wait 2>/dev/null || true
}

# bash does not run a signal's trap inside that same trap, so the handler only counts: the first signal
# makes the loops below exit (the EXIT trap then stops everything), a second one, which can arrive while
# the worker is still being waited for, TERMs every group at once and leaves
sigs=0
on_signal() {
  sigs=$((sigs + 1))
  if [ "$sigs" -ge 2 ]; then force_stop; fi
}
check_signal() { if [ "$sigs" -gt 0 ]; then exit 130; fi; }

force_stop() {
  local g
  for g in ${pgids[@]+"${pgids[@]}"}; do kill -TERM -- "-$g" 2>/dev/null || true; done
  exit 130
}

wait_group() {
  local n=0
  while kill -0 -- "-$1" 2>/dev/null && [ "$n" -lt 120 ]; do
    sleep 0.5
    n=$((n + 1))
  done
}
trap on_signal INT TERM HUP
trap stop_all EXIT

docker compose up -d --wait postgres
pnpm db:migrate

start api pnpm api
until curl -s -o /dev/null "$AFK_API_URL/"; do
  check_signal
  if ! kill -0 -- "-${pgids[0]}" 2>/dev/null; then
    echo "the API stopped before it came up" >&2
    exit 1
  fi
  sleep 0.5
done

[ "${WEB:-1}" = 0 ] || start web pnpm web
[ "${WORKER:-1}" = 0 ] || start worker pnpm worker

echo "up: API $AFK_API_URL, page http://127.0.0.1:5173 (Postgres stays up when you stop; docker compose stop postgres to stop it)"
echo "next: in Cursor, with the project's repos in the workspace, run /afk-setup (install it once: npx skills@latest add xxh171015/afk-platform)"

# leave as soon as any process dies, then stop the rest (macOS bash 3.2 has no `wait -n`)
while :; do
  check_signal
  for i in "${!pgids[@]}"; do
    if ! kill -0 -- "-${pgids[i]}" 2>/dev/null; then
      echo "${names[i]} exited; stopping the rest" >&2
      exit 1
    fi
  done
  sleep 1
done
