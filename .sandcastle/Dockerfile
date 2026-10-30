# AFK 平台仓库的沙箱镜像：沿用试点仓库（afk-pilot-backend）的 Sandcastle 0.12.0
# `sandcastle init --agent cursor` 模板，锁定 Cursor CLI 版本，并额外装
#   - PostgreSQL 服务端：沙箱里没有 Docker，门禁的 setup 用 scripts/pg-temp.sh
#     在一次性目录里起临时实例，不依赖宿主机服务；
#   - pnpm：门禁命令（typecheck、test、lint）都走 pnpm。
FROM node:22-bookworm

RUN apt-get update && apt-get install -y \
  git \
  curl \
  jq \
  postgresql-common \
  && rm -rf /var/lib/apt/lists/*

# 只要服务端二进制，不要 apt 自带的 main 集群（setup 自己在 /tmp/afk-pg 里 initdb）
RUN echo 'create_main_cluster = false' >> /etc/postgresql-common/createcluster.conf \
  && apt-get update \
  && apt-get install -y postgresql \
  && rm -rf /var/lib/apt/lists/*

ARG PNPM_VERSION=12.15.0
RUN npm install -g "pnpm@${PNPM_VERSION}"

# sandcastle docker build-image 会把这两个参数设成宿主机用户的 UID/GID
ARG AGENT_UID=1000
ARG AGENT_GID=1000
RUN groupmod -o -g $AGENT_GID node && usermod -o -u $AGENT_UID -g $AGENT_GID -d /home/agent -m -l agent node
USER ${AGENT_UID}:${AGENT_GID}

# 锁定 Cursor Agent CLI 版本。升级时改这里，并在平台的 Run 记录里留下版本号。
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

# 容器里没有 keychain。这个变量来自 Docker 的 sbx cursor kit，Cursor 官方文档没写，是否需要待实测（沿用试点仓库的设置）。
ENV AGENT_CLI_CREDENTIAL_STORE=memory

# agent 在沙箱里 commit 需要提交身份；trailer 由 worker 事后补，不在这里配
RUN git config --global user.name "afk-agent" \
  && git config --global user.email "afk-agent@users.noreply.github.com" \
  && git config --global init.defaultBranch main

# skills 只读挂到这里（Cursor CLI 的用户级 skills 目录），先建好目录，避免挂载时属主变成 root
RUN mkdir -p /home/agent/.cursor/skills

WORKDIR /home/agent

# worktree 挂在 /home/agent/workspace，Sandcastle 启动时把工作目录切过去
ENTRYPOINT ["sleep", "infinity"]
