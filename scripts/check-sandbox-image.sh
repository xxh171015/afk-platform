#!/usr/bin/env bash
# Unattended build and check of the platform sandbox image (the union of the
# pilot frontend image and this repo's extras). Writes reports/sandbox-image.env.
# The interactive walk-through is scripts/verify-sandbox-image.sh.
#
# SKIP_BUILD=1 reuses the tagged image. SKIP_PLATFORM_GATE=1 skips this repo's
# gate so a later stage can be re-run without waiting on it.
set -euo pipefail

IMAGE="${AFK_SANDBOX_IMAGE:-sandcastle:afk-platform}"
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DOCKERFILE="$REPO_ROOT/.sandcastle/Dockerfile"
ENV_FILE="${ENV_FILE:-$REPO_ROOT/reports/sandbox-image.env}"
FRONTEND_URL="${AFK_PILOT_FRONTEND:-https://github.com/xxh171015/afk-pilot-frontend.git}"
BACKEND_REPO="${AFK_PILOT_BACKEND:-https://github.com/xxh171015/afk-pilot-backend.git}"

mkdir -p "$(dirname "$ENV_FILE")"
if [[ "${SKIP_BUILD:-}" != 1 ]]; then
  : >"$ENV_FILE"
fi
write_env() {
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if [[ -f "$ENV_FILE" ]]; then
    grep -v "^${key}=" "$ENV_FILE" >"$tmp" || true
    mv "$tmp" "$ENV_FILE"
  fi
  printf "%s=%s\n" "$key" "$value" >>"$ENV_FILE"
  printf '  %s=%s\n' "$key" "$value"
}

github_nwo() {
  local url="$1"
  url="${url#https://github.com/}"
  url="${url%.git}"
  printf '%s' "$url"
}

command -v docker >/dev/null 2>&1 || { echo "docker not found" >&2; exit 1; }
docker info >/dev/null 2>&1 || { echo "Docker is not running" >&2; exit 1; }
[[ -f "$DOCKERFILE" ]] || { echo "missing $DOCKERFILE" >&2; exit 1; }

AGENT_UID="$(id -u)"
AGENT_GID="$(id -g)"
if [[ "${SKIP_BUILD:-}" == 1 ]]; then
  echo "skipping build of $IMAGE"
else
  echo "building $IMAGE from $DOCKERFILE (uid:gid $AGENT_UID:$AGENT_GID)"
  start=$(date +%s)
  docker build -t "$IMAGE" \
    --build-arg "AGENT_UID=$AGENT_UID" --build-arg "AGENT_GID=$AGENT_GID" \
    -f "$DOCKERFILE" "$REPO_ROOT/.sandcastle"
  BUILD_SECONDS=$(($(date +%s) - start))
  write_env BUILD_SECONDS "$BUILD_SECONDS"
fi
IMAGE_BYTES="$(docker image inspect -f '{{.Size}}' "$IMAGE")"
write_env IMAGE_SIZE_MB "$((IMAGE_BYTES / 1024 / 1024))"
write_env COMMIT "$(git -C "$REPO_ROOT" rev-parse HEAD)"
write_env HOST_ARCH "$(uname -m)"

PINNED_CURSOR="$(sed -n 's/^ARG CURSOR_CLI_VERSION=//p' "$DOCKERFILE" | head -n1)"
PINNED_PLAYWRIGHT="$(sed -n 's/^ARG PLAYWRIGHT_VERSION=//p' "$DOCKERFILE" | head -n1)"
PINNED_GO="$(sed -n 's/^ARG GO_VERSION=//p' "$DOCKERFILE" | head -n1)"
CURSOR_CLI_VERSION="$(docker run --rm --entrypoint agent "$IMAGE" --version | tr -d '\r' | tail -n1)"
POSTGRES_VERSION="$(docker run --rm --entrypoint bash "$IMAGE" -c 'bin=$(ls /usr/lib/postgresql/*/bin/postgres | head -1) && "$bin" --version')"
TOOLS="$(docker run --rm --entrypoint bash "$IMAGE" -c 'echo "pnpm $(pnpm --version), node $(node --version), go $(go env GOVERSION), playwright $(npx -y playwright@'"$PINNED_PLAYWRIGHT"' --version)"')"
CHROMIUM="$(docker run --rm --entrypoint bash "$IMAGE" -c 'ls -d /home/agent/.cache/ms-playwright/chromium-* | head -1')"
write_env CURSOR_CLI_VERSION "$CURSOR_CLI_VERSION"
write_env POSTGRES_VERSION "$POSTGRES_VERSION"
write_env TOOLS "$TOOLS"
write_env CHROMIUM "$CHROMIUM"
echo "Cursor CLI: $CURSOR_CLI_VERSION (pinned $PINNED_CURSOR)"
echo "PostgreSQL: $POSTGRES_VERSION"
echo "Go pin: $PINNED_GO"
echo "$TOOLS"
echo "Chromium cache: $CHROMIUM"

FAILED=0
run_gate() {
  local name="$1" dir="$2" script="$3"
  local start_at result
  start_at=$(date +%s)
  if docker run --rm -v "$dir:/home/agent/workspace" --entrypoint bash "$IMAGE" -c "$script"; then
    result=pass
  else
    result=fail
    FAILED=1
  fi
  write_env "${name}_SECONDS" "$(($(date +%s) - start_at))"
  write_env "${name}_RESULT" "$result"
  [[ "$result" == pass ]]
}

WORK="$(mktemp -d)"
E2E_NET=""
E2E_BACKEND=""
cleanup() {
  [[ -n "${E2E_BACKEND:-}" ]] && docker rm -f "$E2E_BACKEND" >/dev/null 2>&1 || true
  [[ -n "${E2E_NET:-}" ]] && docker network rm "$E2E_NET" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

PLATFORM_GATE='set -euo pipefail
cd /home/agent/workspace
awk '"'"'/^setup: /{sub(/^setup: /,""); print "600\t" $0}
     /^    run: /{sub(/^    run: /,""); r=$0}
     /^    timeoutSeconds: /{sub(/^    timeoutSeconds: /,""); print $0 "\t" r}'"'"' .sandcastle/gates.yaml |
while IFS=$'"'"'\t'"'"' read -r secs cmd; do
  echo "== timeout $secs $cmd"; bash -c "timeout $secs $cmd"
done'

if [[ "${SKIP_PLATFORM_GATE:-}" == 1 ]]; then
  echo "skipping platform gate"
else
  git clone --quiet "$REPO_ROOT" "$WORK/platform"
  echo "platform gate"
  run_gate GATE "$WORK/platform" "$PLATFORM_GATE" || echo "platform gate failed (recorded); continuing"
fi

FRONTEND_GATE='set -euo pipefail
cd /home/agent/workspace
npm ci
timeout 300 npm run typecheck
timeout 120 npm run contract:check
timeout 600 npm test
timeout 300 npm run build'

echo "cloning $FRONTEND_URL"
if [[ "$FRONTEND_URL" == https://github.com/* ]]; then
  gh repo clone "$(github_nwo "$FRONTEND_URL")" "$WORK/frontend" -- --depth 1 --quiet
else
  git clone --quiet --depth 1 "$FRONTEND_URL" "$WORK/frontend"
fi
frontend_playwright="$(node -p "const p=require('$WORK/frontend/package.json'); (p.devDependencies&&p.devDependencies['@playwright/test']) || (p.dependencies&&p.dependencies['@playwright/test']) || ''")"
write_env FRONTEND_PLAYWRIGHT "$frontend_playwright"
if [[ -n "$frontend_playwright" && "$frontend_playwright" != "$PINNED_PLAYWRIGHT" ]]; then
  echo "Playwright pin $PINNED_PLAYWRIGHT does not match frontend @playwright/test $frontend_playwright" >&2
  FAILED=1
fi
echo "frontend gate"
run_gate FRONTEND_GATE "$WORK/frontend" "$FRONTEND_GATE" || echo "frontend gate failed (recorded); continuing"

CHROMIUM_SMOKE='set -euo pipefail
bin=$(find /home/agent/.cache/ms-playwright -type f -name chrome | head -1)
test -n "$bin"
"$bin" --headless --disable-gpu --no-sandbox --screenshot=/tmp/blank.png about:blank
test -s /tmp/blank.png
echo chromium-launched'

echo "chromium smoke"
mkdir -p "$WORK/smoke"
run_gate CHROMIUM_SMOKE "$WORK/smoke" "$CHROMIUM_SMOKE" || echo "chromium smoke failed (recorded); continuing"

# Shop e2e needs the real backend. The sandbox has no Docker, so this host
# script starts the integration backend and joins the image to its network.
echo "cloning $BACKEND_REPO"
if [[ "$BACKEND_REPO" == https://github.com/* ]]; then
  gh repo clone "$(github_nwo "$BACKEND_REPO")" "$WORK/backend" -- --depth 1 --quiet
else
  git clone --quiet --depth 1 "$BACKEND_REPO" "$WORK/backend"
fi
E2E_NET="afk-sandbox-e2e-$$"
E2E_BACKEND="afk-sandbox-e2e-backend-$$"
docker network create "$E2E_NET" >/dev/null
docker build --pull=false -t afk-sandbox-e2e-backend:local "$WORK/backend"
docker run -d --name "$E2E_BACKEND" --network "$E2E_NET" --network-alias backend \
  afk-sandbox-e2e-backend:local >/dev/null
for _ in $(seq 1 30); do
  if docker exec "$E2E_BACKEND" node -e "fetch('http://localhost:8080/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
docker run --rm --network "$E2E_NET" --pull never \
  -v "$WORK/backend/scripts:/seed:ro" -e BACKEND_URL=http://backend:8080 \
  node:22-bookworm-slim node --experimental-strip-types /seed/seed.ts
echo "frontend e2e"
e2e_start=$(date +%s)
if docker run --rm --network "$E2E_NET" -e BACKEND_URL=http://backend:8080 \
  -v "$WORK/frontend:/home/agent/workspace" --entrypoint bash "$IMAGE" -c \
  'set -euo pipefail; cd /home/agent/workspace; npx playwright test --reporter=list'; then
  write_env FRONTEND_E2E_SECONDS "$(($(date +%s) - e2e_start))"
  write_env FRONTEND_E2E_RESULT pass
else
  write_env FRONTEND_E2E_SECONDS "$(($(date +%s) - e2e_start))"
  write_env FRONTEND_E2E_RESULT fail
  FAILED=1
  echo "frontend e2e failed (recorded); continuing"
fi

echo "wrote $ENV_FILE"
cat "$ENV_FILE"
exit "$FAILED"
