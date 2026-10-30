# Sandcastle 0.12.0 里跨仓库快照与 compose 网络怎么接

2026-10-30 · 对应调研票 xxh171015/afk-platform#64（地图 #62）。只列事实，不做决定；怎么用由 #68（跨仓库的上下文）和 #70（联调环境原型在 Mac 上跑通）定。

## 结论

1. **`docker({ network })`** 只是把名字原样拼成 `docker run --network <name>`（数组就重复多次），不检查网络是否存在，也不做别的处理。传 `afk-<run-id>_default` 能直接加入。网络不存在时 `docker run` 失败，`createSandbox()` / `run()` 抛 `docker run failed: …`，**但按 Docker 源码，容器会先被创建、启动时才失败，于是留下一个 `Created` 状态的 `sandcastle-<uuid>` 容器，Sandcastle 不会删它**。compose 的默认网络是普通的用户自定义 bridge，不是 `internal`，接在上面就能经 NAT 出公网（访问 Cursor API），不需要再接默认 bridge。
2. **`mounts[].readonly: true`** 就是 `-v host:sandbox:ro,z`。`hostPath` 支持绝对路径、`~`、相对 `process.cwd()` 的路径，**在调用 `docker({...})` 时**就检查是否存在，不存在立即抛错；目录挂载的 `sandboxPath` 没有位置限制，`/refs/<repo>`、`/context` 都可以，`~/.afk/...` 也可以当 `hostPath`。只有“挂单个文件”时，`sandboxPath` 的父目录必须在 `/home/agent` 下。
3. **门禁沙箱能同样加入网络。** `createSandbox({ sandbox })` 和 `run({ sandbox })` 吃的是同一个 `SandboxProvider`，都走 `provider.create` → 同一个 `docker run`；`sandbox.exec` 是 `docker exec` 进这个容器，网络自然一样。门禁要不要跑 e2e 是设计问题，API 上没有障碍。
4. **容器名是 `sandcastle-<randomUUID>`，没有任何 label，`docker()` 也没有传 label 的选项。** 能用来找“挂着某个 compose 网络的沙箱”的是 Docker 自己的手段：`docker ps --filter network=<名字>`（官方文档说只匹配运行中的容器）、`docker network inspect` 的 `.Containers`，或者沿用 M1 按挂载目录找的办法。还要注意：只要沙箱还挂在网络上，`docker compose down` **不会报错，只给一个 “Resource is still in use” 警告，网络留下**。
5. **`git archive <SHA> | tar -x`**：子模块只导出成空目录；`export-ignore` 的文件不在快照里，`export-subst` 的文件内容会被替换；属性默认取自被导出的那个 tree，可以用 `$GIT_DIR/info/attributes`（优先级最高）覆盖。导出时会跑 `convert_to_working_tree`，所以**装了 git-lfs 且配置了 `filter.lfs.*` 时导出的是 LFS 真实内容（可能要联网下载），否则是指针文件**。耗时在本仓库（247 个文件，2.3 MB）上是 34 ms 导出 + 18 ms 解包，真实仓库要在 Mac 上测。

## 来源与版本

- **npm 包** `@ai-hero/sandcastle@0.12.0`：在 scratch 目录 `npm pack` 后解压，只读、没有运行。下文 `pkg:` 指包内文件。docker provider 的实现在 `pkg:dist/chunk-CP3TYXZA.js`（`pkg:dist/sandboxes/docker.js` 只是从这里 re-export），挂载工具函数在 `pkg:dist/chunk-VOG34SRF.js`。
- **tag 源码**：本地 clone `~/workspace/sandcastle` 的 tag `v0.12.0`（`package.json` 里 version 是 `0.12.0`），下文 `src:` 指这个 tag 上的文件。抽查过 dist 和源码一致：`--network` 拼法（`pkg:dist/chunk-CP3TYXZA.js` 82–83）、容器名（同文件 133）、`hostPath` 存在性检查（`pkg:dist/chunk-VOG34SRF.js` 26825）、`ro` 选项（同文件 26940）。
- **Docker**：官方文档（docs.docker.com，2026-10-30 读）；moby 源码 tag `v27.5.1` 的 `daemon/create.go`、`daemon/container_operations.go`；Docker Compose 源码 tag `v2.32.4` 的 `pkg/api/labels.go`、`pkg/compose/create.go`、`pkg/compose/down.go`。Mac 上实际装的 Docker 版本没有核对，见「需要在 Mac 上实测」。
- **git**：git-scm.com 上的 `git-archive`、`gitattributes` 文档；git 源码 tag `v2.51.0` 的 `archive.c`；git-lfs 的 `docs/man/git-lfs-faq.adoc`（main）。本机 git 2.43.0，没有 git-lfs。
- 本机没有 Docker，所有 Docker 相关结论都来自读源码和文档，没有运行。
- 平台现状：`packages/pipeline/src/sandcastle.ts`（唯一 import Sandcastle 的模块）、`packages/worker/src/sandboxes.ts`（按挂载目录找孤儿容器）。

## 1. `docker({ network })`

**实现**：`DockerOptions.network?: string | readonly string[]`（`src:src/sandboxes/docker.ts` 70–78，`pkg:dist/sandboxes/docker.d.ts` 48–55），原样传给 `startContainer`（`src:src/sandboxes/docker.ts` 192）。`startContainer` 把它规范成数组，每项拼一个 `--network <n>`，接在 `docker run -d --name <容器名> -e … -v … -w … --user … --network … <镜像>` 里（`src:src/DockerLifecycle.ts` 139–144、156–170）。不传时没有 `--network`，用 Docker 默认 bridge（`docker.d.ts` 53 的注释）。

**传 compose 网络名**：Sandcastle 不解析、不校验名字，所以 `docker({ network: "afk-<run-id>_default" })` 就是 `docker run --network afk-<run-id>_default`，能直接加入已存在的网络。

关于名字本身（Docker Compose 的事实，不是 Sandcastle 的）：

- compose 的默认网络名是 `<项目名>_default`；项目名可以用 `-p`、`COMPOSE_PROJECT_NAME`、顶层 `name:` 设置，`-p` 优先级最高（docs.docker.com/compose/how-tos/networking/、/compose/how-tos/project-name/）。
- 项目名只允许小写字母、数字、`-`、`_`，且必须以小写字母或数字开头（同上 project-name 页）。所以 `<run-id>` 里如果有大写或其他字符，`-p afk-<run-id>` 会被拒绝或得到别的名字，要先确认 run-id 的格式。
- compose 文件可以用 `networks.default.name` 给默认网络改名，也可以把它声明为 `external`（networking 页）。这两种情况下网络名都不是 `afk-<run-id>_default`。联调的 `compose.yaml` 来自后端仓库，平台控制不了它的内容。
- compose 建的网络带 label `com.docker.compose.project=<项目名>` 和 `com.docker.compose.network=<compose 里的网络键，默认是 default>`（compose `pkg/api/labels.go` 29、39；`pkg/compose/create.go` 126–127）。所以 `docker network ls --filter label=com.docker.compose.project=afk-<run-id> --filter label=com.docker.compose.network=default` 能找到真实的网络名，不受改名影响。

**网络不存在时**：

- Sandcastle 不预检。`docker run` 失败时 `dockerExec` 抛 `DockerError`，消息是 `docker run failed: <docker 的 stderr>`（`src:src/DockerLifecycle.ts` 14–20），向上表现为 `createSandbox()` / `run()` 的 reject。
- **容器会被留下。** moby 在 create 阶段故意忽略“网络不存在”：`daemon/create.go` 341 的注释是 “The referenced network k might not exist when the container is created, so just ignore the error in that case.”；`daemon/container_operations.go` 428–435 里 `FindNetwork` 出错也只是不改名字。所以 `docker run` 是先 create 成功、start 时才因为找不到网络失败（`docker run` 没有 `--rm`，CLI 不会删掉它）。结果是一个 `Created` 状态的 `sandcastle-<uuid>` 容器。
- Sandcastle 这边：`startContainer` 失败时 `create()` 直接抛出，后面的 `registerShutdown` 和 `close()` 都没登记（`src:src/sandboxes/docker.ts` 179–199、236–245），所以没人会删这个容器。`createSandbox` 的出错路径只删 worktree（`src:src/createSandbox.ts` 1052–1057）。
- 平台现有的 `removeSandboxesUnder` 用 `docker ps -q`，只看运行中的容器（`packages/worker/src/sandboxes.ts` 53），找不到这种 `Created` 容器。
- 上面这条是读 moby 源码推出来的，需要在 Mac 上实测确认（`docker run --network 不存在的名字 …` 后看 `docker ps -a`）。

**能否出公网（Cursor API）**：

- compose 默认网络的 driver 是 bridge，是用户自定义 bridge。Docker 文档：bridge 网络“Uses masquerading to give containers external network access”，用户自定义 bridge 还“provide automatic DNS resolution between containers”（docs.docker.com/engine/network/drivers/bridge/）。所以只接 `afk-<run-id>_default` 一个网络，就能访问公网，也能用服务名（如 `backend`）访问 compose 里的服务。
- 例外是 `internal: true`：“creates it without a connection to the host's network interfaces”；同时接一个 internal 网络和一个非 internal 网络的服务仍可以经后者出网（networking 页）。如果 compose 文件把默认网络设成 internal，沙箱就到不了 Cursor API（design.md 已写明不能设 internal）。
- 同时接两个网络（例如 `network: ["bridge", "afk-x_default"]`）：Sandcastle 会拼两个 `--network`。Docker Engine 25.0 起 `docker run` / `docker create` 才支持多个 `--network`（Engine 25.0 release notes：“Add support for specifying multiple `--network` flags with `docker container create` and `docker run`.”）。只接 compose 网络就能出网，所以通常用不到。默认 `bridge` 能否和用户自定义网络在 `docker run` 时同时指定，没有查到文档，要实测。
- 沙箱容器在 compose 网络里的 DNS 名只有它自己的容器名 `sandcastle-<uuid>`（和容器 ID）。compose 服务反过来访问沙箱（例如后端回调前端 dev server）时，只能用这个随机名字。

## 2. `mounts` 与 `readonly: true`

**类型**：`MountConfig = { hostPath; sandboxPath; readonly? }`，`readonly` 默认 `false`（`src:src/MountConfig.ts` 8–25）。

**解析时机**：`docker(options)` 一被调用就执行 `resolveUserMounts` 和 `processFileMountParents`（`src:src/sandboxes/docker.ts` 137–145；`pkg:dist/chunk-CP3TYXZA.js` 123–124），不是在创建沙箱时执行。也就是说，挂载的检查错误在构造 provider 时同步抛出。平台的 `provider()` 是在 `run({ sandbox: provider(...) })` 的参数里、`try` 块内调用的（`packages/pipeline/src/sandcastle.ts` 112–116），会被归为 `errorKind: "other"`；门禁则是在 `open()` 里调用（同文件 170–173），错误直接从 `open()` 抛出。

**`hostPath` 规则**（`src:src/mountUtils.ts` 53–66、98–119）：

- `~` / `~/…` 用 `os.homedir()` 展开（worker 进程的 HOME）；相对路径相对 `process.cwd()`（worker 进程的 cwd，不是 `createSandbox` 的 `cwd` 选项）；绝对路径原样用。
- 路径不存在就抛 `Mount hostPath does not exist: …`。没有其他限制：`~/.afk/context/<run-id>`、`~/.afk/snapshots/<repo>@<sha>` 都可以。
- 不做 realpath。docker 拿到的就是展开后的字符串。

**`sandboxPath` 规则**（`src:src/mountUtils.ts` 74–91）：

- 绝对路径原样用；`~` 展开成 `/home/agent`；相对路径相对 `SANDBOX_REPO_DIR`（`/home/agent/workspace`）。
- **目录挂载没有位置限制**：`/refs/frontend`、`/context` 都行。镜像里不存在的挂载点由 Docker 创建（Docker 的通常行为，`/refs` 会被建成 root 拥有的目录；M1 的 `/context` 已经这样用了，见 `packages/pipeline/src/sandcastle.ts` 33–52）。
- **文件挂载才有限制**：`hostPath` 是文件时，`sandboxPath` 的父目录必须是 `/home/agent` 或它下面的目录，否则在 `docker()` 时抛 `Cannot mount file to …: parent directory … is outside the sandbox home directory`（`src:src/mountUtils.ts` 363–398）。在 `/home/agent` 下的父目录，容器启动后会用 root `mkdir -p` 再 `chown` 给 agent 用户（`src:src/sandboxes/docker.ts` 201–231）。

**生成的参数**：`formatVolumeMount` 生成 `-v <hostPath>:<sandboxPath>[:ro][,z]`，`selinuxLabel` 默认 `"z"`（`src:src/mountUtils.ts` 335–345；`src:src/DockerLifecycle.ts` 131–135）。所以 `readonly: true` 就是 `-v …:…:ro,z`。`z` 在没有 SELinux 的系统上（含 macOS 的 Docker Desktop）不起作用（README 的 `selinuxLabel` 注释）。用户挂载排在内部挂载（worktree、`.git`）之后（`src:src/sandboxes/docker.ts` 162）。

**注意点**：

- `-v` 用 `:` 分隔，Sandcastle 不转义。`hostPath` 或 `sandboxPath` 里有 `:`（以及 `,` 出现在选项位置时）会被 docker 错误解析。`<repo>@<sha>` 本身没问题，repo 名不能含 `:`。
- 没有检查 `sandboxPath` 和内部挂载（`/home/agent/workspace`、主 clone 的 `.git` 路径）是否重叠，重叠时交给 docker 报错或覆盖。
- `mounts` 属于 provider 实例，`/context` 和 `/refs/*` 每次运行都不同，所以每次都要重新调用 `docker({...})`（#2 的调研已指出）。
- `:ro` 是 bind mount 的只读选项。容器里即使有 root（例如镜像给了 sudo），在 Docker 默认 capability 下（没有 `CAP_SYS_ADMIN`）也不能把它 remount 成可写。这一条是 Docker 的通常行为，没有在 Sandcastle 源码里找到额外处理，建议在 #70 里顺手验证。
- macOS 的 Docker Desktop 只能挂共享目录，`/Users` 默认共享。`~/.afk` 在 `/Users/<user>` 下，M1 已经在 Mac 上挂过 `/context`。

## 3. 门禁的 `sandbox.exec` 沙箱能否加入网络

- `CreateSandboxOptions.sandbox: SandboxProvider`（`src:src/createSandbox.ts` 72），和 `run()` 用的是同一种 provider。两者最终都走 `startSandbox` → `provider.create(...)`（`src:src/startSandbox.ts` 111、151；`src:src/createSandbox.ts` 787–809、974–999）。docker provider 的 `create` 只有一个实现，`network`、`mounts` 对两者完全一样。
- `sandbox.exec(command)` 是 `docker exec [-i] [-w cwd] <容器名> sh -c <command>`（`src:src/sandboxes/docker.ts` 250–263；`src:src/createSandbox.ts` 685–691），在同一个容器、同一个网络命名空间里执行。
- 所以只要门禁的 `provider()` 也传 `network`，门禁命令就能访问 `http://backend:8080`。平台现在 agent 和门禁共用 `provider(config, ctxDir?)`（`packages/pipeline/src/sandcastle.ts` 60–64），都没有传 `network`。
- 生命周期上的事实：`run()` 结束时容器就删了，门禁 `open()` 时新建容器，`close()` 时删（`src:src/sandboxes/docker.ts` 384–387）。如果门禁也要跑 e2e，compose 环境要一直活到门禁结束。
- #2 已指出 `sandbox.exec` 没有超时也没有 signal，e2e 命令要自己用 `timeout` 包住。

## 4. 容器名、标签，以及 worker 被杀后的清理

**Sandcastle 给的**：

- 容器名 `sandcastle-${randomUUID()}`（`src:src/sandboxes/docker.ts` 154；`pkg:dist/chunk-CP3TYXZA.js` 133），每次随机，和 run、分支、网络都无关。
- `docker run` 参数里没有 `--label`（`src:src/DockerLifecycle.ts` 156–170），`DockerOptions` 也没有 label 选项（`src:src/sandboxes/docker.ts` 37–124）。全包只有 `main.js` 的 init 模板里出现 `--label`，是 `gh issue list` 的参数，与容器无关。
- 能塞进容器、之后能被 `docker inspect` 读到的标记只有环境变量：`DockerOptions.env` 会和其他 env 合并成 `-e K=V`（`src:src/sandboxes/docker.ts` 68–69、184–187；`src:src/DockerLifecycle.ts` 126–129）。`docker ps --filter` 不能按 env 过滤，只能 inspect 后自己筛；这个变量在沙箱里也看得到。
- 自动清理只靠进程内的 `exit` / `SIGINT` / `SIGTERM` 监听器执行 `docker rm -f`（`src:src/shutdownRegistry.ts` 36–54；`src:src/sandboxes/docker.ts` 236–245）。`SIGKILL` 时不会执行，和 M1 演练看到的一致。

**Docker 能给的**：

- `docker ps --filter network=<名字或 ID>`：文档写的是 “Filters running containers connected to a given network”（docs.docker.com/reference/cli/docker/container/ls/）。所以它找不到上面第 1 节那种 `Created` 容器。另外文档例子说的是“name containing `net1`”，看起来是子串匹配，`afk-1_default` 可能也匹配 `afk-12_default`，用前要实测，或者改用网络 ID。
- `docker network inspect <网络> --format '{{range $id, $c := .Containers}}{{$c.Name}} {{end}}'` 列出当前接在网络上的容器（只有活着的端点）。
- `--filter name=^sandcastle-` 能把沙箱和 compose 自己的容器（名字是 `<项目名>-<服务>-<序号>`，带 `com.docker.compose.project` label）分开。
- 平台现有做法（`packages/worker/src/sandboxes.ts` 36–81）是 `docker ps -q` 加 `docker inspect` 看 `.Mounts[].Source`，删掉挂着槽位目录的容器。联调沙箱的 worktree 和 `.git` 也在槽位 clone 里，所以这个办法对加了网络的沙箱同样有效；按网络找是另一条路，不是必需。两种办法都只看运行中的容器。

**和 compose 环境一起清理时的顺序**：

- `docker network rm`：“To remove a network, you must first disconnect any containers connected to it.”（docs.docker.com/reference/cli/docker/network/rm/）
- `docker compose down` 遇到网络上还有容器时不会失败：`removeNetwork` 发现 `len(nw.Containers) > 0` 只发一个 “Resource is still in use” 警告，`continue`，最后 `return nil`（compose `pkg/compose/down.go` 235–238、259）。所以如果先 `compose down` 再删沙箱，命令看起来成功，但网络 `afk-<run-id>_default` 会留下。要么先删沙箱再 down，要么 down 之后再按 label 查一次网络。
- compose 项目名是确定的（`afk-<run-id>`），worker 重启后用 `docker compose -p afk-<run-id> down` 仍然能按 `com.docker.compose.project` label 找到并清掉 compose 自己的容器和网络。

## 5. `git archive <SHA> | tar -x` 生成快照

**导出了什么**（git `archive.c` v2.51.0）：

- **子模块**：gitlink（`S_ISGITLINK`）只写一个目录条目，不递归（`archive.c` 171–172、209–213）。快照里子模块是空目录。`git-archive` 文档对子模块只字未提。
- **`export-ignore`**：带这个属性的文件不进归档（`archive.c` 176–179；gitattributes 文档 “Creating an archive” 一节）。很多仓库会给 `tests/`、`docs/`、`.github/` 加它，这些内容在快照里会缺失，而 agent 参考另一个仓库时可能正需要它们。
- **`export-subst`**：文件里的 `$Format:…$` 会被替换成提交信息，只有给的是 commit/tag 时才替换，每个归档只展开一个 `%(describe)`（gitattributes 文档）。快照内容和仓库里的不完全一样。
- **属性从哪里读**：默认读“被导出的那个 tree”里的 `.gitattributes`（`archive.c` 529–544 把 tree 读进临时 index 并 `git_attr_set_direction(GIT_ATTR_INDEX)`；`git-archive` 文档 ATTRIBUTES 一节）。`--worktree-attributes` 会额外读工作区里的。`$GIT_DIR/info/attributes` 优先级最高（gitattributes 文档），所以在主 clone 的 `.git/info/attributes` 写 `* -export-ignore -export-subst` 应该能让快照不受这两个属性影响（按文档推出，未实测）。
- **LFS 和其他过滤器**：普通文件会经过 `convert_to_working_tree`（`archive.c` 101–111），这个函数会应用 `filter`（smudge）、`text`/`eol`、`ident`。结果是：
  - worker 上装了 git-lfs 并配置了 `filter.lfs.smudge` / `filter.lfs.process`（`git lfs install` 写进全局配置）时，快照里是 LFS 的真实内容。本地没有对象时 smudge 会去 LFS 服务器下载，需要凭据和网络，也可能很慢。
  - 没装 git-lfs，或设了 `GIT_LFS_SKIP_SMUDGE=1`，快照里是指针文件。
  - git-lfs FAQ 说只导出子目录（`git archive <SHA>:<subdir>`）时根目录的 `.gitattributes` 不生效，LFS 根本不会被调用。
  - 例外：大于 `core.bigFileThreshold`（默认 512 MiB）且没有 `export-subst` 的文件直接流式写出，不做转换（`archive.c` 216–220）。LFS 指针很小，不受影响。
- **mtime**：给 commit/tag 时，所有文件的 mtime 都是提交时间；给 tree ID 时是当前时间（`git-archive` 文档）。
- **权限**：`tar.umask` 默认 `0002`（`git-archive` 文档）；本机实测导出的是 `664`/`775`。解包时 tar 还会再套解包用户的 umask。
- **符号链接**原样保留为链接。指向绝对路径的链接在容器里会解析到容器自己的路径；`../` 开头的链接可能指到 `/refs/` 下的其他目录。
- **提交 ID**：tar 格式会写一个 pax 全局扩展头（`comment` 字段是提交 ID），可以用 `git get-tar-commit-id` 读回（`git-archive` 文档）。GNU tar 解包时忽略它。macOS 自带的是 bsdtar，没有核对它对这个头的处理。

**前提和管道**：

- `<SHA>` 必须已经在本地对象库里，要先 `fetch`。GitHub 不支持 `git archive --remote`（`--remote` 需要服务端的 `git-upload-archive`，见 `git-archive` 文档）。
- 在 shell 里 `git archive … | tar -x` 默认只看 `tar` 的退出码，`git archive` 失败（例如 SHA 不存在）可能被吞掉。要用 `set -o pipefail`，或者在 Node 里分别检查两个进程的退出码，或者先 `git archive -o x.tar` 再解包。
- 解包是逐个写文件的，中途被杀会留下半个目录。`~/.afk/snapshots/<repo>@<sha>` 如果按“目录存在就复用”，需要先解到临时目录再 `rename`（rename 在同一文件系统上是原子的）。

**耗时**：本机在 afk-platform 当前 HEAD（247 个文件，tar 2.3 MB）上，`git archive -o` 34 ms，`tar -x` 18 ms。耗时大致和 tree 的总大小成正比，开 LFS smudge 时主要看下载。真实前后端仓库的数字要在 Mac 上测。

## 需要在 Mac 上实测（留给 #70）

1. `docker run --network <不存在的网络>` 后，`docker ps -a` 是否留下 `Created` 的 `sandcastle-<uuid>`；Sandcastle 抛出的错误文本。
2. 只接 `afk-<run-id>_default` 时，沙箱里能否访问 Cursor API、能否用服务名访问后端；compose 文件给默认网络改名、或者设 `internal` 时的表现。
3. `docker ps --filter network=afk-1_default` 是否也匹配 `afk-12_default`（子串匹配）；`Created` 容器的 `.Mounts` 和网络过滤结果。
4. 先 `docker compose down` 后删沙箱时，网络是否留下，`compose down` 的退出码是否为 0。
5. 只读挂载 `/refs/<repo>`：agent 用户和 sudo 下都不能写；`/refs` 被 Docker 自动创建。
6. 用真实仓库测 `git archive | tar -x` 的耗时；如果仓库有 LFS / 子模块 / `export-ignore`，看快照内容；`.git/info/attributes` 覆盖 `export-ignore` 是否生效；bsdtar 解包是否正常。
7. Mac 上 Docker Engine 的版本（多个 `--network` 需要 25.0+，只在需要同时接两个网络时才相关）。
