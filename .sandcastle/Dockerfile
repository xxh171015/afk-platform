# The one sandbox image both projects use (docs/specs/m3-platform.md「沙箱镜像」): the pilot frontend
# image (Node 22, Playwright Chromium) plus this repo's extras (pnpm, a PostgreSQL server). Cursor CLI
# is pinned. Per-repo images stay #159. The sandbox has no Docker; gates that need Postgres start a
# throwaway instance with scripts/pg-temp.sh.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  postgresql-common \
  && rm -rf /var/lib/apt/lists/*

# Only the server binaries: setup initdb's its own cluster under /tmp, not apt's main cluster.
RUN echo 'create_main_cluster = false' >> /etc/postgresql-common/createcluster.conf \
  && apt-get update \
  && apt-get install -y postgresql \
  && rm -rf /var/lib/apt/lists/*

ARG PNPM_VERSION=12.15.0
RUN npm install -g "pnpm@${PNPM_VERSION}"

# Must match afk-pilot-frontend's @playwright/test. OS packages need root; the browser cache is the agent's.
ARG PLAYWRIGHT_VERSION=1.64.1
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install-deps chromium \
  && rm -rf /var/lib/apt/lists/* /root/.npm

# sandcastle docker build-image sets these to the host user's UID/GID.
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# Pin so a Run records a chosen CLI version; bumping this ARG is how that version changes.
ARG CURSOR_CLI_VERSION=2026.10.22-27dcf5f
RUN set -eux; \
  case "$(dpkg --print-architecture)" in \
    amd64) arch=x64 ;; \
    arm64) arch=arm64 ;; \
    *) echo "unsupported arch" >&2; exit 1 ;; \
  esac; \
  dest="$HOME/.local/share/cursor-agent/versions/$CURSOR_CLI_VERSION"; \
  mkdir -p "$dest" "$HOME/.local/bin"; \
  curl -fsSL "https://downloads.cursor.com/lab/$CURSOR_CLI_VERSION/linux/$arch/agent-cli-package.tar.gz" \
    | tar --strip-components=1 -xzf - -C "$dest"; \
  ln -sf "$dest/cursor-agent" "$HOME/.local/bin/agent"; \
  ln -sf "$dest/cursor-agent" "$HOME/.local/bin/cursor-agent"
ENV PATH="/home/agent/.local/bin:$PATH"

ARG PLAYWRIGHT_VERSION=1.64.1
RUN npx -y playwright@${PLAYWRIGHT_VERSION} install chromium && rm -rf /home/agent/.npm

# No keychain in the container. From Docker's sbx cursor kit; Cursor's docs do not mention it.
ENV AGENT_CLI_CREDENTIAL_STORE=memory

# The agent commits inside the sandbox; the worker adds trailers afterwards.
RUN git config --global user.name "afk-agent" \
  && git config --global user.email "afk-agent@users.noreply.github.com" \
  && git config --global init.defaultBranch main

# Skills mount here (Cursor CLI's user-level skills dir). Create it so the mount is not owned by root.
RUN mkdir -p /home/agent/.cursor/skills

WORKDIR /home/agent

# Sandcastle execs in the mounted worktree at workspace; sleep keeps the container up for exec.
ENTRYPOINT ["sleep", "infinity"]
