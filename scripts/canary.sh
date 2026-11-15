#!/usr/bin/env bash
# After upgrading the platform: create a fixed improvement spec, wait until its
# ticket is done (or awaiting-review with --through-final), check token usage,
# implement decisions and gate test names, then cancel and confirm no leftover
# spec/* / agent/* branches or open pull requests.
#
# Usage: scripts/canary.sh --project <id> [--api-url <url>] [--through-final]
# Project id is required. API address comes from --api-url, else plat's config
# ($AFK_API_URL / plat connect), same as any other plat command.
set -euo pipefail

usage() {
  sed -n '2,/^set -euo/p' "$0" | sed -e '$d' -e 's/^# \{0,1\}//'
}

project=""
api_url=""
through_final=0

while [ $# -gt 0 ]; do
  case "$1" in
    --project)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      project=$2
      shift 2
      ;;
    --api-url)
      [ $# -ge 2 ] || { usage >&2; exit 2; }
      api_url=$2
      shift 2
      ;;
    --through-final)
      through_final=1
      shift
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    *)
      usage >&2
      exit 2
      ;;
  esac
done

if [ -z "$project" ]; then
  usage >&2
  exit 2
fi

root="$(cd "$(dirname "$0")/.." && pwd)"
canary="$root/docs/canary"
stamp="${CANARY_STAMP:-$(date -u +%Y-%m-%dT%H:%M:%SZ)}"
slug="canary-$(printf '%s' "$stamp" | tr -d '-' | tr -d ':' | sed 's/T/-/;s/Z$//')"
poll_seconds="${CANARY_POLL_SECONDS:-5}"
timeout_seconds="${CANARY_TIMEOUT_SECONDS:-7200}"
cleanup_seconds="${CANARY_CLEANUP_SECONDS:-120}"

json() {
  node -e '
    const d = JSON.parse(require("fs").readFileSync(0, "utf8"));
    const v = new Function("d", "return (" + process.argv[1] + ");")(d);
    if (v === undefined || v === null) process.exit(0);
    if (typeof v === "object") process.stdout.write(JSON.stringify(v));
    else process.stdout.write(String(v));
  ' "$1"
}

plat_json() {
  if [ -n "$api_url" ]; then
    plat --json --api-url "$api_url" "$@"
  else
    plat --json "$@"
  fi
}

work=""
spec=""
cancelled=0
exit_code=0
repo_url=""
scope=""

finish() {
  if [ -n "$work" ]; then rm -rf "$work"; work=""; fi
  if [ -n "$spec" ] && [ "$cancelled" = 0 ]; then
    plat_json spec cancel "$spec" >/dev/null || true
    cancelled=1
  fi
}
trap finish EXIT

project_json=$(plat_json project show "$project")
repo=$(printf '%s' "$project_json" | json 'd.repos[0].name')
repo_url=$(printf '%s' "$project_json" | json 'd.repos[0].url')

created=$(plat_json spec create \
  --project "$project" \
  --type improvement \
  --title "Canary $stamp" \
  --slug "$slug" \
  --file "$canary/spec.md")
spec=$(printf '%s' "$created" | json 'd.displayId')

work=$(mktemp -d)
sed \
  -e "s/__REPO__/${repo}/g" \
  -e "s/__STAMP__/${stamp}/g" \
  -e "s/^S-0$/${spec}/" \
  "$canary/ticket.md" >"$work/stamp.md"

plat_json tickets import "$spec" "$work" >/dev/null
rm -rf "$work"
work=""

confirm=$(plat_json spec confirm "$spec")
branch=$(printf '%s' "$confirm" | json 'd.integrationBranches[0].branch')
scope=$(printf '%s' "$branch" | sed -n 's|^spec/\([0-9a-f]\{6\}\)/.*|\1|p')

wait_start=$(date +%s)
show=""
while true; do
  show=$(plat_json spec show "$spec")
  spec_state=$(printf '%s' "$show" | json 'd.spec.state')
  if [ "$spec_state" = "paused" ]; then
    reason=$(printf '%s' "$show" | json 'd.spec.pauseReason || "paused"')
    echo "paused: $reason" >&2
    exit_code=1
    break
  fi
  blocked=$(printf '%s' "$show" | json '(d.tickets || []).filter(t => t.state === "blocked").map(t => (t.displayId || "ticket") + " " + (t.blockedReason || "blocked")).join("\n")')
  if [ -n "$blocked" ]; then
    printf '%s\n' "$blocked" >&2
    exit_code=1
    break
  fi
  if [ "$through_final" = 1 ]; then
    if [ "$spec_state" = "awaiting-review" ]; then
      break
    fi
  else
    all_done=$(printf '%s' "$show" | json '(d.tickets || []).length > 0 && (d.tickets || []).every(t => t.state === "done")')
    if [ "$all_done" = "true" ]; then
      break
    fi
  fi
  now=$(date +%s)
  if [ $((now - wait_start)) -ge "$timeout_seconds" ]; then
    echo "timed out waiting for $spec (state ${spec_state:-unknown})" >&2
    exit 1
  fi
  sleep "$poll_seconds"
done

if [ "$exit_code" = 0 ]; then
  tickets=$(printf '%s' "$show" | json '(d.tickets || []).map(t => t.displayId).join(" ")')
  token_ok=0
  decisions_ok=0
  names_ok=0
  usage=$(printf '%s' "$show" | json '(d.usageByStage || []).some(s => Number(s.inputTokens) > 0 || Number(s.outputTokens) > 0 || Number(s.cacheReadTokens) > 0)')
  if [ "$usage" = "true" ]; then
    token_ok=1
  fi
  for ticket in $tickets; do
    view=$(plat_json ticket view "$ticket")
    impl=$(printf '%s' "$view" | json '(d.runs || []).find(r => r.stage === "implement")?.displayId')
    if [ -n "$impl" ]; then
      run=$(plat_json run show "$impl")
      has_token=$(printf '%s' "$run" | json '!!(d.tokenUsage && typeof d.tokenUsage === "object" && (Number(d.tokenUsage.inputTokens) > 0 || Number(d.tokenUsage.outputTokens) > 0 || Number(d.tokenUsage.cacheReadTokens) > 0))')
      if [ "$has_token" = "true" ]; then
        token_ok=1
      fi
      has_decisions=$(printf '%s' "$run" | json 'Array.isArray(d.output && d.output.decisions)')
      if [ "$has_decisions" = "true" ]; then
        decisions_ok=1
      fi
    fi
    has_names=$(printf '%s' "$view" | json '(d.gateResults || []).some(g => Array.isArray(g.testCases) && g.testCases.some(c => c && c.name))')
    if [ "$has_names" = "true" ]; then
      names_ok=1
    fi
  done
  if [ "$token_ok" = 1 ]; then echo "token usage: pass"; else echo "token usage: fail"; exit_code=1; fi
  if [ "$decisions_ok" = 1 ]; then echo "decisions: pass"; else echo "decisions: fail"; exit_code=1; fi
  if [ "$names_ok" = 1 ]; then echo "test names: pass"; else echo "test names: fail"; exit_code=1; fi
fi

if [ -n "$spec" ]; then
  plat_json spec cancel "$spec" >/dev/null
  cancelled=1
fi

cleanup_start=$(date +%s)
leftover=""
while true; do
  show=$(plat_json spec show "$spec")
  prs=$(printf '%s' "$show" | json '(d.pullRequests || []).filter(p => p.state === "open").map(p => (p.repo || "") + " #" + p.number + (p.url ? " " + p.url : "")).join("\n")')
  refs=""
  if [ -n "$repo_url" ]; then
    if [ -n "$scope" ]; then
      refs=$(git ls-remote --heads "$repo_url" | awk -v s="$scope" '
        $2 ~ ("refs/heads/spec/" s "/") { print $2 }
        $2 ~ ("refs/heads/agent/" s "/") { print $2 }
      ') || true
    else
      refs=$(git ls-remote --heads "$repo_url" "refs/heads/spec/*" "refs/heads/agent/*" | awk '{ print $2 }') || true
    fi
  fi
  leftover=""
  if [ -n "$prs" ]; then leftover="${leftover}${prs}"$'\n'; fi
  if [ -n "$refs" ]; then leftover="${leftover}${refs}"$'\n'; fi
  leftover=$(printf '%s' "$leftover" | sed '/^$/d')
  if [ -z "$leftover" ]; then
    break
  fi
  now=$(date +%s)
  if [ $((now - cleanup_start)) -ge "$cleanup_seconds" ]; then
    printf '%s\n' "$leftover" | sed 's/^/leftover: /' >&2
    exit_code=1
    break
  fi
  sleep "$poll_seconds"
done

exit "$exit_code"
