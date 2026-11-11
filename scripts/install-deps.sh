#!/usr/bin/env bash
# Install the workspace's dependencies, trying npm registries in order until one works.
# AFK_NPM_REGISTRIES (space-separated, set by the worker from its configuration) lists them, a public mirror and a
# company one for example; without it the default registry is used. pnpm-lock.yaml records integrity hashes, not
# download addresses, so every registry is checked against the same lockfile.
set -uo pipefail

registries="${AFK_NPM_REGISTRIES:-https://registry.npmjs.org}"
export npm_config_fetch_retries="${npm_config_fetch_retries:-3}"

for registry in $registries; do
  echo "install-deps: trying $registry"
  if pnpm install --frozen-lockfile --registry "$registry"; then
    exit 0
  fi
  echo "install-deps: $registry failed" >&2
done
echo "install-deps: every registry failed: $registries" >&2
exit 1
