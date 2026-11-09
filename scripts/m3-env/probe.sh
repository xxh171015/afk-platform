#!/usr/bin/env bash
# M3 环境摸底（#197）：只读检查这台机器，把结果以 Markdown 打到标准输出。不改任何配置。
#
#   bash probe.sh server                          公司服务器
#   bash probe.sh worker <GitLab 地址> <平台地址>   ThinkPad / Mac（平台地址如 http://10.0.0.5:3000）
#   bash probe.sh listen <端口>                    在服务器上临时监听这个端口，看 worker 和 GitLab webhook
#                                                 能不能连进来；收到的请求逐行打印，Ctrl-C 结束
#
# worker 模式会拉一个小镜像 curlimages/curl 并在容器里测出网（测 Docker 镜像源和容器内能否访问 Cursor），
# 用完的容器自动删除，镜像留着（docker rmi curlimages/curl:8.10.1 可删）。
set -uo pipefail
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/sbin:/sbin:$PATH"

CURL_IMAGE="curlimages/curl:8.10.1"
has() { command -v "$1" >/dev/null 2>&1; }
# 代理地址里的用户名密码换成 ***
mask() { sed -E 's#(://)[^/@[:space:]]+@#\1***@#g'; }
line() { printf -- '- %s\n' "$*"; }

# 打一次 HTTP(S)，任何状态码都算连得上；000 是连不上，附上 curl 的错误
reach() {
  local label="$1" url="$2" out err code
  err=$(mktemp)
  out=$(curl -sS -o /dev/null -m 10 -w '%{http_code} %{time_total}' "$url" 2>"$err")
  code="${out%% *}"
  if [[ -n "$code" && "$code" != "000" ]]; then
    printf '| %s | %s | ✅ HTTP %s，%ss |\n' "$label" "$url" "$code" "${out#* }"
  else
    printf '| %s | %s | ❌ %s |\n' "$label" "$url" "$(tr '\n' ' ' <"$err" | mask | cut -c1-120)"
  fi
  rm -f "$err"
}

# a >= b（只比前三段数字）
version_ge() {
  awk -v a="$1" -v b="$2" 'BEGIN {
    split(a, x, /[^0-9]+/); split(b, y, /[^0-9]+/)
    for (i = 1; i <= 3; i++) { if (x[i] + 0 > y[i] + 0) exit 0; if (x[i] + 0 < y[i] + 0) exit 1 }
    exit 0 }'
}

section_system() {
  echo "### 系统"
  if [[ "$(uname -s)" == "Darwin" ]]; then
    line "系统：macOS $(sw_vers -productVersion)，$(uname -m)"
    line "CPU：$(sysctl -n hw.ncpu) 核；内存：$(( $(sysctl -n hw.memsize) / 1073741824 )) GiB"
  else
    local pretty="未知"
    [[ -r /etc/os-release ]] && pretty=$(. /etc/os-release && echo "$PRETTY_NAME")
    line "系统：${pretty}，内核 $(uname -r)，$(uname -m)"
    line "CPU：$(nproc) 核；内存：$(free -h | awk '/^Mem:/ {print $2 "（可用 " $7 "）"}')"
  fi
  line "根分区：$(df -h / | awk 'NR == 2 {print $2 " 总，" $4 " 可用"}')"
  echo
}

section_docker() {
  echo "### Docker"
  if ! has docker; then line "❌ 没有 docker 命令"; echo; return; fi
  local server
  if ! server=$(docker version --format '{{.Server.Version}}' 2>&1); then
    line "❌ docker 连不上守护进程：$(echo "$server" | tail -1 | cut -c1-150)"
    echo; return
  fi
  if version_ge "$server" "25.0.5"; then
    line "Docker Engine：${server}（✅ ≥ 25.0.5，internal 网络不转发外部 DNS）"
  else
    line "Docker Engine：${server}（⚠ 低于 25.0.5，沙箱出网方案要求升级）"
  fi
  line "Compose：$(docker compose version --short 2>/dev/null || echo '❌ 没有 docker compose 插件')"
  local root
  root=$(docker info --format '{{.DockerRootDir}}' 2>/dev/null)
  line "存储驱动：$(docker info --format '{{.Driver}}' 2>/dev/null)；cgroup：v$(docker info --format '{{.CgroupVersion}}' 2>/dev/null)；Docker 可用 CPU / 内存：$(docker info --format '{{.NCPU}} 核 / {{.MemTotal}}' 2>/dev/null | awk '{printf "%s %s %s %.1f GiB", $1, $2, $3, $4 / 1073741824}')"
  if [[ "$(uname -s)" != "Darwin" ]]; then
    line "Docker 数据目录：${root}（$(df -hT "$root" 2>/dev/null | awk 'NR == 2 {print $2 "，" $3 " 总，" $5 " 可用"}')）"
  fi
  line "镜像源（registry mirrors）：$(docker info --format '{{json .RegistryConfig.Mirrors}}' 2>/dev/null)"
  line "守护进程代理：HTTP=$(docker info --format '{{.HTTPProxy}}' 2>/dev/null | mask) HTTPS=$(docker info --format '{{.HTTPSProxy}}' 2>/dev/null | mask) NO_PROXY=$(docker info --format '{{.NoProxy}}' 2>/dev/null)"
  if [[ -r "$HOME/.docker/config.json" ]] && grep -q '"proxies"' "$HOME/.docker/config.json"; then
    line "⚠ ~/.docker/config.json 配了 proxies（会注入到所有新容器）"
  fi
  local warnings
  warnings=$(docker info 2>&1 | grep -i '^WARNING' | head -5)
  [[ -n "$warnings" ]] && line "docker info 警告：$(echo "$warnings" | tr '\n' ' ')"
  echo
}

section_proxy() {
  echo "### 代理"
  local vars
  vars=$(env | grep -iE '^(https?|no|all)_proxy=' | mask | sort)
  if [[ -n "$vars" ]]; then echo "$vars" | while read -r v; do line "环境变量 $v"; done
  else line "环境变量里没有 HTTP(S)_PROXY"; fi
  has git && [[ -n "$(git config --global --get http.proxy)" ]] && line "git http.proxy：$(git config --global --get http.proxy | mask)"
  has npm && [[ -n "$(npm config get https-proxy 2>/dev/null | grep -v null)" ]] && line "npm https-proxy：$(npm config get https-proxy | mask)"
  if has apt-config; then
    local apt
    apt=$(apt-config dump 2>/dev/null | grep -i 'proxy' | mask | tr '\n' ' ')
    [[ -n "$apt" ]] && line "apt 代理：$apt"
  fi
  echo
}

section_reach() {
  echo "### 从本机出去"
  echo
  echo "| 目标 | 地址 | 结果 |"
  echo "| --- | --- | --- |"
  local label url
  while IFS='|' read -r label url; do
    [[ -n "$url" ]] && reach "$label" "$url"
  done
  echo
}

section_container() {
  echo "### 从容器里出去"
  if ! docker version >/dev/null 2>&1; then line "跳过：docker 不可用"; echo; return; fi
  local started=$SECONDS pulled
  if pulled=$(docker pull -q "$CURL_IMAGE" 2>&1); then
    line "拉镜像 ${CURL_IMAGE}：✅ $((SECONDS - started))s（测的是 Docker Hub 或配置的镜像源）"
  else
    line "拉镜像 ${CURL_IMAGE}：❌ $(echo "$pulled" | tail -1 | mask | cut -c1-150)"
    echo; return
  fi
  echo
  echo "| 目标 | 地址 | 结果 |"
  echo "| --- | --- | --- |"
  # 宿主机有代理时原样带进容器，模拟沙箱经代理出网
  docker run --rm -e HTTPS_PROXY -e HTTP_PROXY -e NO_PROXY -e https_proxy -e http_proxy -e no_proxy \
    --entrypoint sh "$CURL_IMAGE" -c '
      for pair in "$@"; do
        label="${pair%%|*}"; url="${pair#*|}"
        out=$(curl -sS -o /dev/null -m 10 -w "%{http_code} %{time_total}" "$url" 2>/tmp/err)
        code="${out%% *}"
        if [ -n "$code" ] && [ "$code" != "000" ]; then echo "| $label | $url | ✅ HTTP ${code}，${out#* }s |"
        else echo "| $label | $url | ❌ $(tr "\n" " " </tmp/err | cut -c1-120) |"; fi
      done' sh "$@" | mask
  echo
}

section_server() {
  echo "### 服务器网络"
  if has ip; then
    ip -4 -o addr show scope global 2>/dev/null | awk '{print $2, $4}' | while read -r dev addr; do line "网卡 ${dev}：$addr"; done
  fi
  line "主机名：$(hostname -f 2>/dev/null || hostname)"
  if has ss; then
    line "已在监听的 TCP 端口：$(ss -ltnH 2>/dev/null | awk '{n = split($4, a, ":"); print a[n]}' | sort -n -u | tr '\n' ' ')"
    local port
    for port in 80 443 3000 5432 8080; do
      if ss -ltnH "sport = :$port" 2>/dev/null | grep -q .; then line "端口 ${port}：已被占用"; else line "端口 ${port}：空闲"; fi
    done
  fi
  if has ufw; then line "ufw：$(sudo -n ufw status 2>/dev/null | head -1 || echo '要 sudo 才能看（sudo ufw status）')"; fi
  if has firewall-cmd; then line "firewalld：$(firewall-cmd --state 2>&1 | head -1)"; fi
  has docker && line "已有的 compose 项目数：$(docker compose ls -q 2>/dev/null | wc -l | tr -d ' ')"
  echo
}

listen() {
  local port="$1"
  local code='
import datetime, http.server, sys
class H(http.server.BaseHTTPRequestHandler):
    def handle_any(self):
        n = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(n)
        print("%s 来自 %s：%s %s  X-Gitlab-Event=%s" % (datetime.datetime.now().strftime("%H:%M:%S"),
              self.client_address[0], self.command, self.path, self.headers.get("X-Gitlab-Event")), flush=True)
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.end_headers()
        self.wfile.write(b"afk probe ok\n")
    do_GET = do_POST = do_PUT = handle_any
    def log_message(self, *args): pass
print("在 0.0.0.0:%s 上监听，Ctrl-C 结束" % sys.argv[1], flush=True)
http.server.ThreadingHTTPServer(("0.0.0.0", int(sys.argv[1])), H).serve_forever()
'
  if has python3; then exec python3 -c "$code" "$port"; fi
  echo "没有 python3，改用容器 python:3.12-alpine" >&2
  exec docker run --rm -p "$port:$port" python:3.12-alpine python -c "$code" "$port"
}

main() {
  local mode="${1:-}"
  case "$mode" in
    server)
      echo "## 公司服务器 · $(date '+%Y-%m-%d %H:%M')"
      echo
      section_system
      section_docker
      section_proxy
      section_server
      section_reach <<'EOF'
飞书开放平台|https://open.feishu.cn
Docker Hub|https://registry-1.docker.io/v2/
npm|https://registry.npmjs.org/
GitHub|https://github.com
EOF
      ;;
    worker)
      local gitlab="${2:?用法：bash probe.sh worker <GitLab 地址> <平台地址>}"
      local platform="${3:?用法：bash probe.sh worker <GitLab 地址> <平台地址>}"
      local me
      me=$(hostname -s 2>/dev/null || hostname)
      echo "## 构建机 $me · $(date '+%Y-%m-%d %H:%M')"
      echo
      section_system
      section_docker
      section_proxy
      section_reach <<EOF
公司 GitLab|${gitlab%/}/users/sign_in
平台服务器|${platform%/}/probe-from-$me
Cursor API|https://api2.cursor.sh
Cursor agent|https://agent.api5.cursor.sh
Cursor 下载（建镜像用）|https://downloads.cursor.com
npm|https://registry.npmjs.org/
Docker Hub|https://registry-1.docker.io/v2/
GitHub|https://github.com
飞书开放平台|https://open.feishu.cn
EOF
      section_container \
        "Cursor API|https://api2.cursor.sh" \
        "Cursor agent|https://agent.api5.cursor.sh" \
        "npm|https://registry.npmjs.org/" \
        "公司 GitLab|${gitlab%/}/users/sign_in" \
        "平台服务器|${platform%/}/probe-from-$me-container"
      ;;
    listen)
      listen "${2:?用法：bash probe.sh listen <端口>}"
      ;;
    *)
      sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'
      exit 2
      ;;
  esac
}

main "$@"
