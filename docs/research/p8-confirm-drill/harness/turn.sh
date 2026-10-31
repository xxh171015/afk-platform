#!/bin/bash
# One turn of the P8 drill: turn.sh <run-number> <message>. Runs Cursor CLI in the platform's sandbox image, which sees
# only the drill repo, the skills and the plat stand-in. The first turn of a run makes a fresh copy of the repo and
# starts a chat; later turns resume it. Each turn's event stream is kept in /tmp/afk-p8/run-<n>/turn-<k>.jsonl.
set -euo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.local/bin:$PATH"
here="$(cd "$(dirname "$0")" && pwd)"
n="$1"
msg="$2"
skills="$HOME/.afk/skills@5beb35b/skills/engineering" # to-tickets is identical to the pinned 59db609
opt="/tmp/afk-p8/opt"
if [ ! -d "$opt" ]; then
  mkdir -p "$opt/bin"
  cp "$here/bin/plat" "$opt/bin/plat"
fi
run="/tmp/afk-p8/run-$n"
if [ ! -d "$run/repo" ]; then
  mkdir -p "$run/cursor-home/skills"
  cp -R "$here/repo" "$run/repo"
  git -C "$run/repo" init -q && git -C "$run/repo" add -A && git -C "$run/repo" -c user.email=dev@example.com -c user.name=dev commit -qm init
fi
set -a
# shellcheck disable=SC1090
. "$HOME/.afk/env"
set +a
k=$(find "$run" -maxdepth 1 -name 'turn-*.jsonl' | wc -l | tr -d ' ')
k=$((k + 1))
mkdir -p "$run/api"
printf '=== run %s turn %s: %s\n' "$n" "$k" "$msg" >>"$run/api/calls.log"
resume=""
[ -f "$run/session" ] && resume="--resume $(cat "$run/session")"
docker run --rm --name "afk-p8-r$n-t$k" \
  -e CURSOR_API_KEY -e AFK_MODEL -e AFK_API_URL=http://host.docker.internal:8787 -e P8_MSG="$msg" -e P8_RESUME="$resume" \
  -v "$run/repo:/home/agent/workspace" \
  -v "$run/cursor-home:/home/agent/.cursor" \
  -v "$skills:/home/agent/.cursor/skills:ro" \
  -v "$opt:/opt/plat:ro" \
  -w /home/agent/workspace --entrypoint bash sandcastle:afk-platform \
  -lc 'export PATH=/opt/plat/bin:$PATH; agent -p --trust --output-format stream-json --model "$AFK_MODEL" $P8_RESUME "$P8_MSG"' \
  >"$run/turn-$k.jsonl" 2>"$run/turn-$k.err" || true
python3 "$here/show.py" "$run/turn-$k.jsonl" "$run/session"
tail -5 "$run/turn-$k.err" 2>/dev/null || true
