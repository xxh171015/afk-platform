# Docker 沙箱的出网白名单和容器加固

2026-11-08 · 对应决策票 xxh171015/afk-platform#200（地图 #196）

## 结论

1. **出网白名单用「internal 网络 + 显式 HTTP(S) 代理」。** 每台构建机建一个 `--internal` 的 Docker 网络 `afk-egress`，放一个双网卡的代理容器（squid 或 tinyproxy，按 CONNECT 的目标域名放行，不解 TLS），沙箱只接 internal 网络，用 `HTTP(S)_PROXY` 指向代理；公司有上游代理时由这个代理容器转出去。internal 网络没有默认路由，不认代理的工具连不出去，所以失败是关着的（fail closed）。Docker Engine ≥ 25.0.5 / 26.0 时，只接 internal 网络的容器的外部 DNS 查询也不会被转发出去，DNS 外泄顺带堵上了。
2. **iptables / nftables 按 IP 放行和 DNS 过滤都不单独用。** 按 IP 放行要把域名解析成 IP，CDN 的 IP 会变，Cursor 官方也建议按域名放行而不是 IP；规则放在容器里要给 `NET_ADMIN`（agent 能自己删规则），放在宿主机上 Docker 29 的 nftables 后端又没有 `DOCKER-USER` 链（而且是实验功能）。DNS 过滤挡不住直连 IP。它们最多当纵深防御。
3. **联调环境的 compose 网络要改成 internal。** 现在沙箱接进 compose 默认网络后经 NAT 直接出网，绕过白名单。平台在 `compose -f …` 后面多加一个自己生成的覆盖文件，把 `networks.default.internal` 设成 `true`；沙箱同时接 `afk-egress` 和 compose 网络（Sandcastle 的 `network` 本来就接受数组），`NO_PROXY` 填 compose 里的服务名。服务本来就不向宿主机暴露端口（M2 spec），internal 不影响现有流程。
4. **Sandcastle 0.12.0 的 `docker()` 能透传的只有 `--user`、`-v`、`-e`、`-w`、`--network`、`--group-add`、`--device`、`--cpus`，没有任何「额外参数」出口。** 加固要的 `--cap-drop`、`--security-opt no-new-privileges`、`--pids-limit`、`--memory`、`--init`、`--label` 都传不进去。不 fork 的做法是用公开 API `createBindMountSandboxProvider` 在 `pipeline` 包里写一个加固版 docker provider（把 0.12.0 的 `docker()` 照搬约 200 行，再加参数）。上游 0.13.0 加了 `capDrop` 和 `sandboxId`，但到 main 为止仍然没有内存、进程数、no-new-privileges，所以就算升级也还得自己包一层。
5. **容器加固 M3 做这几项：** `--cap-drop ALL`、`--security-opt no-new-privileges`、保留默认 seccomp 和 AppArmor、`--pids-limit`、`--memory` 等于 `--memory-swap`、`--cpus`、`--init`（`sleep infinity` 当 PID 1 不收僵尸进程，配了进程数上限后僵尸会占名额）、`--label afk.run=<id>`。非 root 已经做到了（Sandcastle 总是 `--user <宿主 UID>:<GID>`，镜像里 `USER` 也是非 root）。**不做**：只读根文件系统（容器每次运行都是新的、用完就删，收益小，代价是 Cursor CLI 装在 `~/.local`、pnpm / npm 缓存和门禁的临时 Postgres 都要单独给 tmpfs）、userns-remap 和 rootless Docker（两者都会让沙箱写进 bind mount 的 worktree / `.git` 文件在宿主机上变成别的 UID，和 Sandcastle 固定 `--user <宿主 UID>` 的做法冲突）、`--storage-opt size`（overlay2 要求底层是带 `pquota` 的 xfs，ThinkPad 上的 Ubuntu 默认是 ext4）。
6. **白名单起步只放：Cursor（`.cursor.sh`，必要时加 `.cursorapi.com`）+ 各语言的包源（优先公司内网镜像）。** GitLab 默认不放：agent 没有 git 凭据，只有用 GitLab 包仓库的团队才需要。Maven / Gradle 不读 `HTTPS_PROXY`，要在镜像里写 `settings.xml` / `gradle.properties`；Go 要把 `GOPROXY` 里的 `direct` 去掉；Node 自己的 `fetch` 要 `NODE_USE_ENV_PROXY=1`。白名单最终以代理的访问日志为准，先在 Mac 上演练一轮再定。

剩余风险（白名单挡不住的）：经被放行的服务外泄（例如往包源发布包、往 Cursor 发内容）；联调环境的 `docker build` 在宿主机上带完整网络执行快照里 agent 写过的 Dockerfile；internal 网络的网关 IP 能访问宿主机上监听 `0.0.0.0` 的服务。

## 来源与版本

- **Sandcastle 0.12.0**：仓库 `node_modules/.pnpm/@ai-hero+sandcastle@0.12.0/node_modules/@ai-hero/sandcastle/` 下的发布包，下文记作 `pkg:`。拼 `docker run` 参数的代码在 `pkg:dist/chunk-CP3TYXZA.js`（`startContainer`、`docker()`），选项定义在 `pkg:dist/sandboxes/docker.d.ts`，自定义 provider 的 API 在 `pkg:dist/SandboxProvider-EkSMuBp8.d.ts` 和 `pkg:README.md`「Custom Sandbox Providers」。
- **Sandcastle 上游**（`gh`，2026-11-08）：v0.13.0 / v0.14.0 的 release notes；main 上的 `src/sandboxes/docker.ts`。
- **平台代码**：`packages/pipeline/src/sandcastle.ts`（唯一调用 Sandcastle 的模块）、`packages/pipeline/src/integration-env.ts`、`.sandcastle/Dockerfile`；`docs/design.md`「上服务器前的检查项」、`docs/specs/m2-platform.md`「联调环境」。
- **Docker 官方文档**（2026-11-08 读取）：
  - [`docker network create` · `--internal`](https://docs.docker.com/reference/cli/docker/network/create/#internal)
  - [`docker run` 参考](https://docs.docker.com/reference/cli/docker/container/run/)（`--init`、`--storage-opt`、`--ulimit`、`--network` 多次）
  - [`dockerd` 参考](https://docs.docker.com/reference/cli/dockerd/)（`no-new-privileges`、`default-ulimits`、`cgroup-parent`、`userns-remap`、代理）
  - [Packet filtering · iptables](https://docs.docker.com/engine/network/firewall-iptables/)、[nftables](https://docs.docker.com/engine/network/firewall-nftables/)
  - [Bridge 网络驱动](https://docs.docker.com/engine/network/drivers/bridge/)
  - [CLI 代理配置](https://docs.docker.com/engine/cli/proxy/)
  - [Running containers](https://docs.docker.com/engine/containers/run/)（默认 capability、内存）
  - [userns-remap](https://docs.docker.com/engine/security/userns-remap/)、[Rootless](https://docs.docker.com/engine/security/rootless/)、[Rootless troubleshooting](https://docs.docker.com/engine/security/rootless/troubleshoot/)
  - [Docker Sandboxes security model](https://docs.docker.com/ai/sandboxes/security/)（同类产品的做法）
  - [Compose spec · networks · internal](https://github.com/compose-spec/compose-spec/blob/main/06-networks.md#internal)
  - [moby 安全公告 GHSA-mq39-4gv4-mvpx / CVE-2024-29018](https://github.com/moby/moby/security/advisories/GHSA-mq39-4gv4-mvpx)
- **Cursor 官方文档**（2026-11-08 读取）：
  - [Network Configuration](https://cursor.com/docs/enterprise/network-configuration)
  - [CLI Configuration · Proxy configuration](https://cursor.com/docs/cli/reference/configuration)
  - [CLI changelog](https://cursor.com/docs/cli/changelog)
  - [Help · Network, proxy, and remote connections](https://cursor.com/help/troubleshooting/network)
- **包管理器**：[npm config](https://docs.npmjs.com/cli/v11/using-npm/config)、[pnpm network settings](https://pnpm.io/settings/network)、[Maven proxies](https://maven.apache.org/guides/mini/guide-proxies.html)、[Go Modules Reference](https://go.dev/ref/mod)、[Node.js CLI · `NODE_USE_ENV_PROXY`](https://nodejs.org/api/cli.html#node_use_env_proxy1)。
- **代理**：[tinyproxy 文档](https://tinyproxy.github.io/)、[Squid · SslPeekAndSplice](https://wiki.squid-cache.org/Features/SslPeekAndSplice)、Squid 配置参考（[`acl`](https://www.squid-cache.org/Doc/config/acl/)、[`cache_peer`](https://www.squid-cache.org/Doc/config/cache_peer/)、[`never_direct`](https://www.squid-cache.org/Doc/config/never_direct/)）。
- **同类做法**：Claude Code devcontainer 的 [`init-firewall.sh`](https://github.com/anthropics/claude-code/blob/main/.devcontainer/init-firewall.sh)（iptables + ipset）。

这台机器没有 Docker，**以上结论都没有实测**。标了「待实测」的地方要在 Mac（`ssh mac`）上的原型里验证。

## 1. Sandcastle 0.12.0 能透传什么

`startContainer` 拼出的命令固定是（`pkg:dist/chunk-CP3TYXZA.js` 54–107）：

```
docker run -d --name sandcastle-<uuid> \
  -e K=V …            # provider env + agent env + HOME=/home/agent
  -v host:sandbox[:ro][,z] …   # worktree、主 clone 的 .git、用户 mounts
  -w <worktree>
  --user <uid>:<gid>  # 默认宿主机的 process.getuid()/getgid()
  [--network n …] [--group-add g …] [--device d …] [--cpus n]
  <image>
```

| `DockerOptions` 字段 | 对应参数 | 备注 |
| --- | --- | --- |
| `imageName` | 镜像名 | 启动前 `docker image inspect` 校验镜像 `USER` 的 UID 和 `containerUid` 一致 |
| `containerUid` / `containerGid` | `--user` | 默认宿主 UID/GID |
| `selinuxLabel` | `-v …:z` | Ubuntu 上无效果 |
| `mounts` | `-v` | |
| `env` | `-e` | 和 agent 的 env 合并 |
| `network` | `--network`，可以是数组 | 数组 → 多个 `--network` |
| `groups` | `--group-add` | |
| `devices` | `--device` | |
| `cpus` | `--cpus` | |
| `maxOutputTailChars` | 不是 docker 参数 | |

**传不进去的**：`--cap-drop`、`--security-opt`、`--pids-limit`、`--memory`/`--memory-swap`、`--read-only`/`--tmpfs`、`--init`、`--label`、`--dns`、`--ulimit`、`--userns`、`--runtime`。没有 `extraArgs` 之类的出口，容器名 `sandcastle-<uuid>` 也不暴露（0.13.0 才有 `sandboxId`），所以连事后 `docker update --memory --pids-limit` 都做不到。

**其他值得注意的行为**：

- 容器用镜像的 `ENTRYPOINT`（我们的镜像是 `sleep infinity`）常驻，agent 和门禁命令都经 `docker exec … sh -c` 进去；`close()` 时 `docker stop` + `docker rm`。容器是一次性的。
- 只有挂载**文件**（不是目录）且父目录不存在时，Sandcastle 会 `docker exec --user 0:0` 去 `mkdir` + `chown`（`pkg:dist/chunk-VOG34SRF.js` `processFileMountParents`）。平台只挂目录（`/context`、`/refs/*`、skills），不会走到这里；所以 `--cap-drop ALL` 不影响现有挂载。
- `exec({ sudo: true })` 会在命令前加 `sudo`；平台不用，镜像里也没装 sudo。
- Sandcastle 用的是 `docker` CLI，所以 `~/.docker/config.json` 里的 `proxies` 会被自动注入成新容器的 `HTTP_PROXY` 等环境变量（[CLI 代理配置](https://docs.docker.com/engine/cli/proxy/)）。不建议依赖这个：它对构建机上的所有容器生效，包括联调环境的服务；平台显式经 `docker({ env })` 传更清楚。

**要包一层：自定义 provider。** `createBindMountSandboxProvider` 是包根导出的公开 API，README 有完整例子。0.12.0 的 `docker()` 本身就是用它写的（`pkg:dist/chunk-CP3TYXZA.js` 113–326），平台照搬到 `packages/pipeline` 里，在 `docker run` 参数里加上加固项即可，不需要 fork。照搬时会丢掉两样内部东西：

- `registerShutdown`（未导出）：Sandcastle 用它在进程收到信号时 `docker rm -f` 所有容器。自己的 provider 要在 worker 里自己注册退出清理，并且有了 `--label afk.run=<id>` 之后，worker 启动时可以按 label 清理上次残留的容器。
- `checkImageUid`：几十行，直接照抄。

顺带的好处：provider 在 `close()` 删容器之前可以 `docker inspect --format '{{.State.OOMKilled}}'`，把「被内存上限杀掉」记进 Run 的失败归因。

`sandcastle.ts` 开头写着「唯一导入 Sandcastle 的模块」，新 provider 要么写进这个文件，要么把这条约定放宽到 `pipeline` 包里的 `sandcastle*.ts`。

**上游版本**：v0.13.0（2026-11-02）加了 `capDrop` 和 `sandboxId`，并修了「bind-mount 沙箱以读写方式挂载宿主 `.git`」的安全问题（旧调研 `research/sandcastle-0.12-api` 的额外发现 2）；main 上 `DockerOptions` 仍然只有 `imageName`、`containerUid/Gid`、`selinuxLabel`、`mounts`、`env`、`network`、`groups`、`capDrop`、`devices`、`maxOutputTailChars`、`cpus`。所以无论升不升级，内存 / 进程数 / no-new-privileges 都要自定义 provider；`.git` 只读这个修复是另一个值得单独决定是否升级的理由（地图约定锁 0.12.0，这里不改）。

## 2. 出网白名单的几种做法

| 做法 | 强度 | 坑 |
| --- | --- | --- |
| **A. internal 网络 + 显式代理**（推荐） | 强。internal 网络「没有默认路由，防火墙规则丢弃和其他网络之间的所有流量」（[`--internal`](https://docs.docker.com/reference/cli/docker/network/create/#internal)），只能经代理出去；代理按 CONNECT 的主机名放行，目标由代理自己解析和连接，沙箱指定不了别的 IP | 每种工具要认代理（见第 4 节）；按域名放行挡不住被放行服务上的外泄和共享 CDN 上的 domain fronting；internal 网络的网关 IP 仍可达（见下） |
| B. 宿主机 iptables（`DOCKER-USER`）按 IP 放行 | 中。要把域名解析成 IP，CDN 的 IP 会变（Cursor 文档明说「Rather than maintaining IP address lists (which can change), configure your firewall to allow traffic to these domain patterns」） | `DOCKER-USER` 看到的是 DNAT 之后的地址，按原始目标匹配要 conntrack，「may result in degraded performance」（[iptables](https://docs.docker.com/engine/network/firewall-iptables/)）；Docker 29 的 nftables 后端「there is no `DOCKER-USER` chain」，而且是实验功能（[nftables](https://docs.docker.com/engine/network/firewall-nftables/)） |
| C. 容器内 iptables + ipset（Claude Code devcontainer 的做法） | 弱到中。启动时解析一次域名，没有刷新；放行任意 UDP 53 | 容器要 `NET_ADMIN`，agent 能自己改规则；和「沙箱里什么特权都没有」冲突 |
| D. 只做 DNS 过滤 | 弱。直连 IP、DoH 都绕得过去 | 只适合当补充 |
| E. 透明代理（iptables REDIRECT + squid 按 SNI peek/splice） | 中到强，不用给工具配代理 | 要宿主机 iptables 和 squid 的 ssl-bump 端口；Squid 文档提醒 step 1/2 的判断「rely on client-supplied data」，没有 SNI 的连接只能按 IP 判断（[SslPeekAndSplice](https://wiki.squid-cache.org/Features/SslPeekAndSplice)）。复杂度不值得 |

同类产品 Docker Sandboxes 也是 A 的思路：「outbound TCP traffic is proxied through the host and governed by a deny-by-default policy」，并且提醒默认放行的宽通配（如 `*.googleapis.com`）覆盖的服务远比需要的多（[security model](https://docs.docker.com/ai/sandboxes/security/)）。

### 推荐的形态（每台构建机一套）

```
           ┌──────────── afk-egress（--internal，bridge 名 afk-egress0）─────────────┐
           │                                                                         │
 沙箱 ─────┤  HTTP(S)_PROXY=http://afk-egress-proxy:3128                              │
 (agent /  │                                                                         │
  门禁)    │                       afk-egress-proxy（squid / tinyproxy）─────────────┼── afk-egress-out（普通 bridge）── NAT ──▶ 公司上游代理 / 公网
           └─────────────────────────────────────────────────────────────────────────┘
```

- `docker network create --internal -o com.docker.network.bridge.name=afk-egress0 afk-egress`；代理容器 `--restart unless-stopped`，同时接 `afk-egress` 和一个普通网络。代理容器是 worker 启动时确保存在的基础设施（和 worker 一起由 `plat` 管），白名单文件只读挂进去。
- 沙箱的 env（经 provider 的 `env` 注入）：`HTTP_PROXY`、`HTTPS_PROXY`、小写的 `http_proxy`、`https_proxy`、`NO_PROXY`/`no_proxy`（`localhost,127.0.0.1` 加联调服务名）、`NODE_USE_ENV_PROXY=1`。
- **DNS**：CVE-2024-29018 的修复之后（Moby ≥ 26.0.0-rc3 / 25.0.5 / 23.0.11），只接 internal 网络的容器的外部 DNS 请求不再经宿主机转发（[公告](https://github.com/moby/moby/security/advisories/GHSA-mq39-4gv4-mvpx)）。沙箱不需要解析外部域名（代理替它解析），容器名解析（`afk-egress-proxy`、联调服务名）走 Docker 内置 DNS，不受影响。构建机的 Docker 版本要满足这个下限。**待实测**：沙箱同时接两个 internal 网络时同样不转发。
- **网关 IP**：internal 网络上「Communication with the gateway IP address (and thus appropriately configured host services) is possible」。宿主机上监听 `0.0.0.0` 的服务（sshd、Mac 上平台的 3000 端口和 Postgres 等）沙箱都能连到。对策：给网桥固定名字 `afk-egress0`，宿主机加一条 `INPUT -i afk-egress0 -j DROP`（Linux），或让这些服务只监听 `127.0.0.1`。**待实测**；Mac 上的 Docker Desktop 跑在 VM 里，网关是 VM 的，影响不同。
- **公司上游代理**：squid 用 `cache_peer <公司代理> parent <端口> 0 no-query default` + `never_direct allow all`；tinyproxy 用 `Upstream http <公司代理>:<端口>`。沙箱只认识 `afk-egress-proxy`，公司代理地址和认证信息不进沙箱。
- **代理选型**：两者都只做 CONNECT 域名放行、不解 TLS，所以不需要给沙箱装自签 CA。
  - squid：`acl allowed dstdomain .cursor.sh registry.npmjs.org …`、`http_access allow CONNECT allowed`、`http_access deny all`；`http_port` 不开 ssl-bump。访问日志字段齐全（客户端 IP、方法、主机、状态码），适合拿来做失败归因和白名单调整。
  - tinyproxy：`Filter` 文件 + `FilterDefaultDeny Yes`（白名单）+ `FilterType fnmatch`，`ConnectPort 443`；更轻，日志较简单。
  - 倾向 squid（日志和上游代理配置更成熟）；镜像版本锁死，配置进仓库。
- **被拒的请求要看得见**：代理返回 403，工具报错里通常只有「403 / tunnel failed」。平台在 Run 失败时把这次运行期间代理日志里被拒的主机名附到失败原因里（按沙箱 IP 过滤，provider 知道容器 IP），否则「白名单不全」会被误判成 agent 失败。

### 白名单的作用范围

M3 先用**一份全平台的白名单**（每台构建机一份，所有项目共用，内容是所有团队包源的并集），由负责人改，放在平台配置里，worker 拉作业时同步给代理并 reload。按项目区分（squid 要靠代理认证区分来源，或者每次运行起一个代理）放到 #159 每仓库镜像那一段。白名单**不能**放在仓库里由 agent 改得到的位置；如果放仓库，规则和门禁配置一样，从基准提交读。

## 3. 联调环境（compose）下怎么保持白名单

现状：`integration-env.ts` 用 `docker compose -p afk-<run> -f 片段… up`，沙箱经 `docker({ network: <compose 默认网络> })` 接进去。compose 默认网络不是 internal，沙箱经 NAT 直接出网（`docs/design.md` 的联调图里也画着「经 NAT 出网」）。

做法：

1. 平台生成一个覆盖文件，放在所有片段之后 `-f`：

   ```yaml
   networks:
     default:
       internal: true
   ```

   Compose spec：「`internal`, when set to `true`, allows you to create an externally isolated network」（[networks · internal](https://github.com/compose-spec/compose-spec/blob/main/06-networks.md#internal)）。片段如果自己声明了别的网络，平台拒绝（或同样覆盖成 internal）。
2. 沙箱 `network: ["afk-egress", <compose 默认网络>]`：Sandcastle 0.12.0 支持数组，`docker run` 支持重复 `--network`（[`docker run --network`](https://docs.docker.com/reference/cli/docker/container/run/#network)）。两张网都是 internal，没有出网路由，出网只能走 `afk-egress-proxy`。
3. `NO_PROXY` 加上 compose 里所有服务名（平台本来就从片段里读出了服务列表和 `x-afk-env`），e2e 对 `http://backend:8080` 的请求直连，不进代理。
4. 不把代理容器接到 compose 网络上：`stop()` 的注释已经说了「a network with a container still attached survives `compose down`」，代理常驻会让每个联调网络都删不掉。

影响：

- M2 spec 定了「环境的服务不向宿主机暴露端口，只在 compose 网络里访问」，`--wait` 靠容器内健康检查，所以 internal 不影响启动和 e2e。**待实测**：`compose up --wait` 和 `compose run --rm seed-*` 在 internal 网络上照常工作。
- 服务和 seed 在运行时也连不了外网。需要外网的服务（调第三方 API）要么在片段里 mock，要么平台给它们也注入代理 env；先按「不允许」处理，碰到再说。
- **没堵上的口子**：服务镜像是 worker 在宿主机上 `docker build` 快照得到的，快照里是 agent 写过的代码，Dockerfile 的 `RUN` 带着完整网络执行。BuildKit 的 `--network` 只有 `default` / `none` / `host`，要把构建也关进白名单得换成接在 `afk-egress` 上的 buildx 容器构建器，复杂度不小，记为剩余风险，不在 M3 做。

## 4. 需要放行的域名和各工具的代理配置

**原则**：先最小，跑一轮看代理日志的 403 再加；能用公司内网镜像（Nexus 等）就只放内网镜像一个主机。下表是起步清单，不是定稿。

| 用途 | 放行 | 工具怎么认代理 |
| --- | --- | --- |
| Cursor Agent CLI | `.cursor.sh`（`api2.cursor.sh` 大部分 API；`api5.cursor.sh` 及 `agent.api5.cursor.sh`、`agentn.api5.cursor.sh` 等 agent 请求）；必要时 `.cursorapi.com` | `HTTPS_PROXY` + `NODE_USE_ENV_PROXY=1`（[CLI 配置 · Proxy](https://cursor.com/docs/cli/reference/configuration)）；流式连接认 `HTTPS_PROXY` 从 v2026.06.09 起（changelog「Proxy support for agent streams」），镜像锁的 2026.10.22 已包含 |
| npm / pnpm | `registry.npmjs.org` 或公司镜像 | 都会读 `HTTPS_PROXY` / `HTTP_PROXY` / `NO_PROXY` 环境变量（[npm config](https://docs.npmjs.com/cli/v11/using-npm/config)、[pnpm network](https://pnpm.io/settings/network)） |
| Node 自己的 `fetch` / `http` | — | 要 `NODE_USE_ENV_PROXY=1`（v24.0.0 / v22.21.0 起，「Active Development」）（[Node CLI](https://nodejs.org/api/cli.html#node_use_env_proxy1)）；镜像是 `node:22-bookworm`，要确认 ≥ 22.21 |
| Maven | `repo.maven.apache.org`（或公司 Nexus） | **不读环境变量**，在镜像的 `~/.m2/settings.xml` 写 `<proxies>`（[Maven proxies](https://maven.apache.org/guides/mini/guide-proxies.html)） |
| Gradle | `services.gradle.org`、`plugins.gradle.org`、Maven Central（或公司镜像） | 不读环境变量，`gradle.properties` 写 `systemProp.https.proxyHost/Port` |
| Go | `proxy.golang.org`、`sum.golang.org`（或公司 goproxy） | Go 读 `HTTPS_PROXY`。`GOPROXY` 默认 `https://proxy.golang.org,direct`，`direct` 会去各个 VCS 主机拉代码（[Go Modules Reference](https://go.dev/ref/mod)），要改成不带 `direct`；私有模块用 `GOPRIVATE` 并放行 GitLab |
| Python | `pypi.org`、`files.pythonhosted.org` | pip 读环境变量 |
| GitLab | 默认不放 | agent 没有 git 凭据；只有依赖 GitLab 包仓库 / 私有 Go 模块的团队才放 |
| 不放 | `github.com`、Docker Hub、`downloads.cursor.com`、apt 源 | postinstall 里下二进制的包（如 Playwright 浏览器）要在镜像构建时装好；Cursor CLI 版本锁在镜像里，运行时不需要下载更新 |

Cursor 的签入域名（`authenticator.cursor.sh`、`accounts.x.ai` 等）不需要：沙箱用 `CURSOR_API_KEY`，不走登录。

**公司代理做 TLS 检查时**（待环境摸底票核实）：

- Cursor 建议对其域名关闭 SSL 检查（「Cursor's services are already encrypted end-to-end. We recommend disabling SSL inspection for these domains」），这是要找网络管理员的事项。
- 关不掉时，镜像要信任公司根证书：系统 CA（`update-ca-certificates`）+ `NODE_EXTRA_CA_CERTS`；如果流式输出被缓冲，在镜像的 `~/.cursor/cli-config.json` 设 `network.useHttp1ForAgent: true`（CLI 也会自动回退到 HTTP/1.1）。
- 我们自己的代理只做 CONNECT 隧道，HTTP/2 在隧道里透明传，不影响流式输出。

## 5. 容器加固

| 项 | M3 | 依据和说明 |
| --- | --- | --- |
| 非 root | 已有 | Sandcastle 总是 `--user <uid>:<gid>`，镜像 `USER ${AGENT_UID}` |
| `--cap-drop ALL` | 做 | 非 root 进程本来就没有有效 capability，这一项主要收紧边界集，防 setuid 程序和 `docker exec --user 0:0`；平台只挂目录，不影响 Sandcastle 的挂载流程 |
| `--security-opt no-new-privileges` | 做 | 禁止 setuid 提权（[`--security-opt`](https://docs.docker.com/reference/cli/docker/container/run/#security-opt)）；镜像里没有 sudo |
| seccomp / AppArmor | 保持默认 | 默认 seccomp profile 已启用，「will adjust to the selected capabilities」（[Running containers](https://docs.docker.com/engine/containers/run/)）；只要不传 `unconfined` 就行 |
| `--pids-limit` | 做，起步 1024 | 防 fork 炸弹；门禁跑 vitest worker 和临时 Postgres，按 afk-platform 门禁实测调 |
| `--init` | 做 | 镜像 PID 1 是 `sleep infinity`，不收僵尸；`--init` 用 docker-init（tini）收僵尸（[`--init`](https://docs.docker.com/reference/cli/docker/container/run/#init)），否则僵尸会占进程数名额 |
| `--memory` = `--memory-swap` | 做 | 只设 `--memory` 时 swap 额外再给一份（「total virtual memory size (`--memory-swap`) will be set as double of memory」），所以两者设成相等；值 = (构建机内存 − 预留) ÷ 并发数；OOM 记入失败归因 |
| `--cpus` | 做（0.12.0 已支持） | 并发数 × cpus ≤ 核数 |
| `--label afk.run=<id>` | 做 | 退出清理和残留清扫 |
| `--ulimit nproc` | 不做 | Linux 按用户计数，「not to a container」，同 UID 的多个沙箱会互相挤占（[`--ulimit`](https://docs.docker.com/reference/cli/docker/container/run/#ulimit)）；用 `--pids-limit` |
| `--read-only` + `--tmpfs` | 不做 | 容器每次运行都是新的、用完就删，写层本来就不留；只读要给 `/tmp`（门禁的临时 Postgres）、`~/.cache`、`~/.npm`、pnpm store、`~/.cursor`（CLI 写配置和日志）挂 tmpfs，而 Cursor CLI 装在 `~/.local`，不能整个 home 换成 tmpfs。持久的写入都在 bind mount 的 worktree 上，只读根文件系统挡不住 |
| `--storage-opt size` | 不做 | overlay2 下「only available if the backing filesystem is `xfs` and mounted with the `pquota` mount option」，Ubuntu 默认 ext4；用磁盘监控和清理代替 |
| userns-remap | 不做 | 守护进程级别，影响构建机上所有容器；「if volumes are mounted from the host, file ownership must be pre-arranged」（[userns-remap](https://docs.docker.com/engine/security/userns-remap/)）。沙箱里 UID 1000 写的文件在宿主机上会变成 subuid 范围里的 UID，worker 以宿主用户身份操作 worktree / `.git` 会出权限问题 |
| rootless Docker | 不做 | 同样的 UID 映射问题：rootless 下只有容器里的 root 对应宿主用户，Sandcastle 却固定 `--user <宿主 UID>`，而且启动前会校验镜像 `USER` 必须等于这个 UID；资源限制还要求 cgroup v2 + systemd（[troubleshoot](https://docs.docker.com/engine/security/rootless/troubleshoot/)） |

**构建机 `daemon.json` 的兜底项**（不依赖 Sandcastle，对所有容器生效）：

- `"no-new-privileges": true`：对联调环境的服务也生效；常见的 Postgres 等官方镜像以 root 起、再用 gosu 降权，不受影响，但以非 root 起、靠 sudo / setuid 的镜像会坏。可选。
- `"cgroup-parent": "<slice>"`：把所有容器挂到一个 systemd slice 下，再给这个 slice 设总的 `MemoryMax` / `TasksMax`，当作并发沙箱之外的总上限。可选。
- 不设 `default-ulimits` 的 `nproc`（同上）。

## 6. 给 M3 spec 的建议改动

- 新组件「出网代理」：每台构建机一个，worker 负责确保 `afk-egress` 网络和代理容器存在、同步白名单、按沙箱 IP 取被拒记录。
- `pipeline` 包新增加固版 docker provider（基于 `createBindMountSandboxProvider`），替换 `sandcastle.ts` 里的 `docker()`；参数：`cap-drop ALL`、`no-new-privileges`、`pids-limit`、`memory`、`cpus`、`init`、`label`、`network: ["afk-egress", …]`、代理 env；关闭前记录 OOMKilled。
- `integration-env.ts` 加 internal 覆盖文件，`NO_PROXY` 加服务名。
- `docs/design.md`「上服务器前的检查项」里「出网白名单：只放行模型 API、npm 源、GitLab」改成「Cursor + 包源（优先内网镜像），GitLab 按需」，「容器加固」一条补上自定义 provider 的做法。
- 构建机前置条件：Docker Engine ≥ 25.0.5 / 26.0（internal 网络不转发外部 DNS）、cgroup v2。
- 原型（Mac 上，`ssh mac`）要验证：internal 网络 + squid 能让 Cursor CLI 跑完一次 implement；pnpm install 和门禁走代理通过；双 internal 网络下 DNS 不外泄；网关 IP 的可达性和宿主机 INPUT 规则；`compose up --wait` 和 seed 在 internal 网络上正常；`--pids-limit` / `--memory` 下 afk-platform 门禁的余量。

## 待确认

- 公司网络：构建机出网是否必须走公司代理、代理是否做 TLS 检查、有没有 npm / Maven / Go 的内网镜像（环境摸底票）。
- 各团队实际用的包源和语言，决定白名单起步清单。
- Docker Desktop（Mac）上 internal 网络和网关的行为与 Linux 不同，Mac 上的演练结果要和 ThinkPad 分开看。
