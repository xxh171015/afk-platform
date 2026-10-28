# Sandcastle 0.12.0 对设计所依赖 API 的支持情况

2026-10-28 · 对应决策票 xxh171015/afk-platform#2（地图 #1）

## 结论

`@ai-hero/sandcastle@0.12.0` 支持设计依赖的大部分能力，cursor provider 的三个限制也都还成立。但有三处和设计写法不一致，需要改设计：

1. **worktree 锁（ADR 0007）没有发布。** ADR 已经接受，但实现只在一个没合并的分支上，0.12.0 和当前 main 里都没有。两个运行用同一个分支名时，会悄悄共用同一个 worktree。
2. **`Output.object` 只有顶层 `run()` 支持。** `createSandbox()` 的 `sandbox.run()` 和 `createWorktree()` 的 `wt.run()` 都不接受 `output`，而 `sandbox.exec` 又只在 `Sandbox` 句柄上有。所以设计里“同一沙箱跑 agent + 结构化输出 + `sandbox.exec` 门禁”没法用一个 API 同时做到。
3. **`copyToWorktree` 只能复制主 clone 里的相对路径，文件不存在时直接跳过、不报错。** 设计写的“从 worker 的密钥目录通过 `copyToWorktree` 带进去”这样做不到。

另外有两点设计里没写，但影响较大（见「额外发现」）：

- 同一个 clone 上并发调用 `run()` / `createSandbox()`，可能互相删掉对方的 worktree（上游 issue #849 还没修）。
- docker 沙箱以读写方式挂载主 clone 的整个 `.git` 目录。这和“写权限只有 worktree 一处”不一致，还有经 git hooks / config 逃逸到宿主机的风险。

## 来源与版本

- **npm 包** `@ai-hero/sandcastle@0.12.0`：用 `npm pack` 下载后解压，只读、没有运行。下文的 `pkg:` 指包里的文件，主要是 `README.md`、`dist/index.d.ts`、`dist/SandboxProvider-EkSMuBp8.d.ts`、`dist/MountConfig-CmXclHA5.d.ts`、`dist/sandboxes/docker.d.ts`、`dist/index.js`、`dist/chunk-VOG34SRF.js`。
- **本地 clone** `~/workspace/sandcastle`：读的是 tag `v0.12.0` 上的文件（`git show v0.12.0:<path>`），下文的 `src:` 都指这个 tag。当前 main（`a53e227`）比 `v0.12.0` 多 23 个 commit，`src/` 下只改了 `InitService.ts`（Codex 的 `.env.example` 变量名），`docs/adr/` 没有改动。所以下面的结论对 main 同样成立。
- 抽查过 dist 和 tag 源码是否一致：`CURSOR_PRINT_PROMPT_MAX_BYTES = 120 * 1024`、cursor 的命令行、`does not support resumeSession`、`output.maxRetries requires …`，两边都一样（`pkg:dist/index.js` 第 20、1022、2846、3264 行）。
- 上游 GitHub 的 issue/PR 状态是用 `gh` 在 2026-10-28 查的。

## 总表

| # | 能力 | 0.12.0 | 和设计的差异 | 要改设计 |
| --- | --- | --- | --- | --- |
| 1 | cursor 三个限制 + `captureSessions` | 三个限制都成立 | `CursorOptions` 只有 `env`，没有 `captureSessions` 选项（内部固定为 `false`）；对 cursor 传 `resumeSession` 会直接抛错 | 否（补充写法） |
| 2 | `Output.object` + zod（cursor 下） | 支持，只限顶层 `run()` | `sandbox.run()` / `wt.run()` 没有 `output`；`maxRetries` 必须是 0 | **是** |
| 3a | `baseBranch` | 支持 | 在 `createSandbox({ baseBranch })` 和 `branchStrategy: { type: "branch", branch, baseBranch }` 上；只在分支不存在时生效；README 没写，只在 `.d.ts` 里有 | 否 |
| 3b | 固定分支名复用 worktree（ADR 0003） | 支持 | 干净的 worktree 在运行结束后会被删掉，只有脏的才留下来复用；复用干净 worktree 时会从 `origin` 快进 | 小改 |
| 3c | worktree 锁（ADR 0007） | **不支持** | 实现 PR #463 还没合并 | **是** |
| 4a | `mounts` + `readonly: true` | 支持 | 一致；挂载配置在 `docker({ mounts })` 上，所以每次运行都要构造新的 provider | 否 |
| 4b | `copyToWorktree` | 支持，但语义不同 | 只接受主 clone 里的相对路径；不存在就静默跳过 | **是** |
| 5 | `docker({ network })` | 支持 | 一致，对应 `--network <name>`，也可以传数组 | 否 |
| 6 | `idleTimeoutSeconds` + `AbortSignal`（ADR 0004） | 支持 | 一致；但工厂函数和 `sandbox.exec` 都不接受 signal | 小改 |
| 7 | `onAgentStreamEvent` | 支持 | 只在 `logging: { type: "file" }` 时触发 | 否 |
| 8 | `sandbox.exec` 跑门禁；`--force` | 都支持 | `exec` 没有超时和 signal；AFK 运行总是传 `--force`，没有其他信任相关参数 | 小改 |
| 9 | docker 镜像装 Cursor CLI | 支持 | 由 `sandcastle init --agent cursor` 生成 `.sandcastle/Dockerfile`；二进制名是 `agent` | 否 |

## 逐项结果

### 1. cursor provider 的三个限制、`captureSessions`

**API**：`cursor(model: string, options?: CursorOptions): AgentProvider`，`CursorOptions` 只有 `env?: Record<string, string>`（`pkg:dist/index.d.ts` 192–197）。

```ts
import { run, cursor } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

await run({
  agent: cursor("composer-2", { env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY! } }),
  sandbox: docker({ imageName: "sandcastle:backend" }),
  branchStrategy: { type: "branch", branch: "agent/T-123", baseBranch: "spec/export" },
  promptFile: "/abs/path/afk-implement.md",
});
```

逐条核对：

- **不能 resume / fork：成立。** cursor 工厂把 `captureSessions` 固定为 `false`，也没有 `sessionStorage`。源码注释写的是“non-resumable per ADR 0012/0016. resumeSession is ignored here”（`src:src/AgentProvider.ts` 837–846）。所以 `RunResult.resume` / `.fork` 不存在：只有 provider 有 `sessionStorage` 时才有这两个方法（`pkg:dist/index.d.ts` 中 `RunResult` 的注释）。传 `resumeSession` 时，`run()` 会先抛出 `cursor does not support resumeSession`（`src:src/resumePrecheck.ts` 30–32）。依据是 ADR 0016：只有会话存成文件的 agent 才支持 resume。
- **prompt 走命令行参数，上限 120KB：成立。** 常量是 `CURSOR_PRINT_PROMPT_MAX_BYTES = 120 * 1024`，按 UTF-8 字节数算，超过就抛错 `Cursor print-mode prompt is N bytes (max 122880 bytes)…`（`src:src/AgentProvider.ts` 123–137）。命令是 `agent --print --output-format stream-json --model '<model>'  --force '<prompt>'`（同文件 849–857），不走 stdin。注意：这个上限针对的是展开后的 prompt，也就是替换完 `{{KEY}}` 并执行完 `` !`cmd` `` 之后的文本。
- **不报 token 用量：成立。** cursor 的 `parseStreamLine` 只产生 `text`、`result`、`tool_call`、`session_id` 四种事件，从不产生 `usage`；`parseSessionUsage` 也只有 Claude Code 实现了（`src:src/AgentProvider.ts` 187–200、`pkg:dist/index.d.ts` 中 `AgentProvider.parseSessionUsage` 的注释）。所以 `IterationResult.usage` 总是 `undefined`。
- **`captureSessions`**：只有 `claudeCode` / `codex` / `pi` 有这个选项，默认 `true`；`cursor` 没有。另外，如果 Cursor 的 stream-json 输出 `{"type":"system","subtype":"init","session_id":…}`，共用的解析器会把它填进 `IterationResult.sessionId`（`src:src/AgentProvider.ts` 110–116），可以记进 Run 方便排查，但不能拿来续接。

**对设计的影响**：「Agent 与 skills 对接」那张限制表可以保留，来源改成 `src/AgentProvider.ts` 里的 `cursor` 工厂和 `src/resumePrecheck.ts`。建议补一句“对 cursor 传 `resumeSession` 或 `output.maxRetries > 0` 会直接抛错”，免得以后有人在配置里打开它们。

### 2. `Output.object` + zod 在 cursor 下怎么取

**API**：`Output.object({ tag, schema, maxRetries? })`。schema 可以是任何 Standard Schema（zod 4 可以直接用），结果在 `result.output` 上，类型由 schema 推出；失败时抛 `StructuredOutputError`，带 `tag`、`rawMatched`、`cause`、`commits`、`branch`、`preservedWorktreePath`、`sessionId?`（`pkg:README.md`「Structured output」、`src:docs/adr/0010-structured-output.md`）。

```ts
import { run, cursor, Output, StructuredOutputError } from "@ai-hero/sandcastle";
import { z } from "zod";

const ImplementResult = z.object({
  status: z.enum(["done", "cannot-proceed"]),
  reason: z.string().optional(),
  summary: z.string(),
  acceptance: z.record(z.string(), z.array(z.string())),
  uncertainties: z.array(z.string()),
});

try {
  const r = await run({
    agent: cursor("composer-2"),
    sandbox: docker({ /* … */ }),
    branchStrategy: { type: "branch", branch: "agent/T-123", baseBranch: "spec/export" },
    promptFile: "/abs/afk-implement.md", // prompt 里必须原样出现 "<result>"
    output: Output.object({ tag: "result", schema: ImplementResult }), // maxRetries 必须是 0
  });
  r.output.status; // 已通过类型检查
} catch (e) {
  if (e instanceof StructuredOutputError) { /* → invalid-output */ }
  throw e;
}
```

在 cursor 下的行为：

- **从哪里取**：Orchestrator 把 cursor stream-json 最后的 `{"type":"result","result":…}` 文本作为这次迭代的输出；没有 result 事件时，退回到原始 stdout（`src:src/Orchestrator.ts` 157–208，`return { result: resultText || execResult.stdout … }`）。`run()` 在这段文本里找**最后一个** `<tag>…</tag>`，去掉可选的 ```` ```json ```` 围栏，再 `JSON.parse` 并用 schema 校验（`src:src/extractStructuredOutput.ts`）。
- **限制**：要求 `maxIterations === 1`；展开后的 prompt 里必须出现开标签字面量 `<result>`，否则一开始就抛错（`src:src/run.ts` 552 附近）。`maxRetries > 0` 要求 provider 支持续接，cursor 会立刻抛错（`src:src/run.ts` 559–575）。所以 cursor 下格式错了不能自动重试，只能判 `invalid-output`，和设计一致。
- **只有顶层 `run()` 有 `output`**：`SandboxRunOptions`（`sandbox.run`）和 `WorktreeRunOptions`（`wt.run`）里都没有这个字段（`pkg:dist/index.d.ts` 中 `ResumeSandboxRunResultOptions` / `SandboxRunOptions` 的定义；`src:src/createSandbox.ts`、`src/createWorktree.ts` 里也搜不到 `output` 选项）。`extractStructuredOutput` 也没有从包根导出。

**对设计的影响（要改）**：设计同时用了 `Output.object` 和 `sandbox.exec`，而这两者分属两个 API。二选一：

- **方案 A**：agent 运行用 `run({ output })`，门禁另起一个 `createSandbox({ branch: "agent/<id>" })` 再 `exec`。好处是门禁跑在新容器里，agent 改过的容器文件系统（`~/.local/bin`、`~/.npmrc`、全局包等）影响不到门禁，更符合原则 7。代价是多起一次容器，另外 `run()` 结束时干净的 worktree 会被删掉（见 3b），补 trailer 需要另找一个 worktree，或者改用 plumbing。
- **方案 B**：用 `createSandbox()` + `sandbox.run()`，worker 自己从 `result.stdout` 里取最后一个 `<tag>` 再用 zod 校验（逻辑大约 20 行，照搬 `extractStructuredOutput` 的规则）。好处是句柄存活期间 worktree 一直在，可以在 `close()` 前在宿主机上补 trailer；也正好配合「额外发现 1」里对工厂调用加锁的做法。

建议用方案 B 跑 agent，门禁仍然另起新沙箱（也就是 B 加上 A 的门禁做法）。设计里的“每次运行用 Sandcastle 的 `Output.object`”应改为“按 Sandcastle `Output.object` 的规则（最后一个标签、去围栏、Standard Schema）由 worker 校验”。

### 3a. `baseBranch`

**API**：有两个入口。

- `createSandbox({ branch, baseBranch?, … })`，注释是“Ref to fork from when `branch` does not yet exist. Ignored when the branch already exists. Defaults to `HEAD`.”（`pkg:dist/index.d.ts` 711–717）
- `NamedBranchStrategy { type: "branch"; branch; baseBranch? }`，可以用在 `run()` / `createWorktree()` / `interactive()` 上，注释还要求“Callers are responsible for ensuring the ref is current (e.g. `git fetch`)”（`pkg:dist/SandboxProvider-EkSMuBp8.d.ts` 204–214）。

实现：先执行 `git worktree add <path> <branch>`，报 `invalid reference` 时再执行 `git worktree add -b <branch> <path> <baseBranch ?? "HEAD">`（`src:src/WorktreeManager.ts` 362–380）。

```ts
await createSandbox({ branch: "agent/T-123", baseBranch: "spec/export", sandbox: docker() });
```

**差异**：README 的 `CreateSandboxOptions` 表里没有 `baseBranch`，只在类型定义里有，不过行为和设计一致。设计让主 clone 停在 detached HEAD 不会出问题：`getCurrentBranch` 只用来填 `TARGET_BRANCH` 这个 prompt 参数，detached 时值是 `"HEAD"`（`src:src/WorktreeManager.ts` 92–97、`src/run.ts` 628–632）。

**对设计的影响**：`spec/<slug>` 要以**本地分支**的形式存在于主 clone 里，并在每次派票前更新到最新（设计已经用 `update-ref` 维护本地 ref，满足要求）。只在 origin 上有的分支不能直接当 `baseBranch` 用，必须先 fetch 成本地 ref。

### 3b. 固定分支名时复用已有 worktree（ADR 0003）

**行为**（`src:src/WorktreeManager.ts` 213–289、`pkg:dist/chunk-VOG34SRF.js` 25209–25330）：

- worktree 目录是 `<cwd>/.sandcastle/worktrees/<branch 里的 / 换成 ->`，例如 `agent/T-123` 对应 `agent-T-123`。
- 如果这个分支已经在 `.sandcastle/worktrees/` 下有 worktree，就复用它：脏的打一条警告、原样复用，**不会丢弃未提交的改动**；干净的先 `git fetch origin <branch>` 再 `git merge --ff-only origin/<branch>`，fetch 失败或分支已分叉就原样复用。
- 如果这个分支被 Sandcastle 管理范围以外的 worktree（包括主工作区）checkout 了，直接报错。
- **运行结束后的清理**：`run()` 结束（成功或失败都一样）时，如果 worktree 没有未提交改动就**删掉 worktree**，分支保留；有改动就保留，路径写在 `preservedWorktreePath` 上（`src:src/SandboxFactory.ts` 200–225）。`createSandbox` / `createWorktree` 的句柄在 `close()` 时按同样的规则处理。

**差异**：设计写的是“重试时 Sandcastle 复用已有 worktree，之前的 commits 不丢”。commits 确实不丢，但它们在**分支**上，不靠 worktree；worktree 只有上次留下了未提交改动时才会被复用。

**对设计的影响（小改）**：

- 第 1 步“复用时有未提交改动就存 diff 再丢弃”需要 worker 在调用 Sandcastle **之前**，自己到 `<clone>/.sandcastle/worktrees/agent-<id>/` 去做，Sandcastle 不会替你丢弃。这个路径规则要写进设计。
- 用顶层 `run()` 时，运行结束后干净的 worktree 已经被删了，第 3 步的 `git rebase --exec` 没有工作区可用。要么用方案 B 在 `close()` 前补，要么改用 `git commit-tree` / `git interpret-trailers` 逐个重写 commit 再 `update-ref`，和集成分支一样只操作 ref。
- 复用干净 worktree 时会 `fetch origin`，所以 worker 推送 `agent/<id>` 之后，本地和 origin 必须一致。设计里每次运行后都推送，满足要求。

### 3c. worktree 锁（ADR 0007）

**结论：0.12.0 没有这个功能。**

- `docs/adr/0007-worktree-locking.md` 在 tag 里（2026-04 接受），规定锁文件放在 `.sandcastle/locks/<name>.lock`，进程还活着时直接报错，PID 已死时清掉旧锁。
- 但 `src:` 和 `pkg:dist/*.js` 里都找不到 `WorktreeLock`、`.sandcastle/locks`、`in use by process`。`create()` 复用 worktree 前只检查是否脏，不检查有没有别人在用（见 3b 引用的代码）。
- 实现提交 `9891de2`、`e091c02`、`23c3eb9` 只在远端分支 `origin/implement/worktree-locking` 上，对应 PR mattpocock/sandcastle#463 状态是 **OPEN**。早先的 PR #440 没有合并就关了；issue #401 虽然标成 completed，代码却没进 main。

**对设计的影响（要改）**：设计不能依赖 Sandcastle 防止两个运行同时用同一个 worktree。要由平台自己保证“同一 `agent/<ticket-id>` 同时最多一个运行”，比如：

- worker 在整个运行期间持有一把 Postgres advisory lock，键为 (repo, ticket)；或者
- 在 `.sandcastle/worktrees/` 旁边放一个 worker 自己的 `O_EXCL` 锁文件。

fencing token 只能挡住 API 写入，挡不住两个进程同时往一个 worktree 写文件。即使上游以后合并了 ADR 0007，它的语义也是直接报错、不等待，worker 仍然要把这种报错当成“作业失败、等重派”来处理。

### 4a. `mounts` 的 `readonly: true`

**API**：`docker({ mounts: MountConfig[] })`，`MountConfig = { hostPath; sandboxPath; readonly? }`，`readonly` 默认 `false`（`pkg:dist/MountConfig-CmXclHA5.d.ts`）。`hostPath` 可以是绝对路径、`~` 或相对 `process.cwd()` 的路径；`sandboxPath` 可以是绝对路径、`~` 或相对 `/home/agent/workspace` 的路径。`hostPath` 不存在时创建沙箱会失败（`pkg:dist/sandboxes/docker.d.ts`）。实际生成的参数是 `-v host:sandbox[:ro][,z]`（`src:src/mountUtils.ts` 331–345）。

```ts
docker({
  imageName: "sandcastle:backend",
  mounts: [
    { hostPath: `~/.afk/context/${runId}`, sandboxPath: "/context", readonly: true },
    { hostPath: `~/.afk/snapshots/frontend@${sha}`, sandboxPath: "/refs/frontend", readonly: true },
    { hostPath: "~/.afk/skills", sandboxPath: "/skills", readonly: true },
  ],
});
```

**差异**：没有差异。注意 `mounts` 属于 provider 实例，每次运行的 `/context/<run-id>` 都不同，所以每次运行都要重新调用 `docker({...})`，provider 实例不能复用。

### 4b. `copyToWorktree`

**API**：`run()`、`createSandbox()`、`createWorktree()`、`wt.createSandbox()` 上的 `copyToWorktree?: string[]`，注释是“Paths relative to the host repo root”。`head` 策略不支持。时序是 `copyToWorktree` → `host.onWorktreeReady` → 起沙箱（`pkg:README.md`「Hooks」）。

**实现**（`src:src/CopyToWorktree.ts` 34–40）：`src = join(hostRepoDir, relativePath)`，`dest = join(worktreePath, relativePath)`，**`src` 不存在就 `continue`**；复制用 `cp -R --reflink=auto`。传绝对路径也会被 `path.join` 拼到主 clone 下面。

**和设计不一致**：设计写“测试用的 `.env` 和 fixture 放在 worker 本机的密钥目录 …… 通过 `copyToWorktree` 带进去”。实际上 `copyToWorktree` 只能复制主 clone（`~/.afk/repos/<repo>/`）里的文件，而且缺文件不会报错。

**对设计的影响（要改）**，任选一种：

- 用 `hooks.host.onWorktreeReady: [{ command: "cp -R ~/.afk/secrets/<repo>/. ." }]`。它在 worktree 目录下执行，命令非零退出就立即失败，比静默跳过安全。
- 把密钥目录用 `mounts` 只读挂进沙箱，在 `sandbox.onSandboxReady` 里复制或软链到位。
- 把文件放进主 clone 的 gitignored 路径，再用 `copyToWorktree`。缺点是缺文件仍然不报错，只能靠门禁比较跳过数兜底。

### 5. `docker({ network })` 加入外部网络

**API**：`network?: string | readonly string[]`，对应一个或多个 `--network <name>`，不传时用默认 bridge（`pkg:dist/sandboxes/docker.d.ts`、`src:src/DockerLifecycle.ts` 139–145、158–170）。

```ts
docker({ network: `afk-${runId}_default` }) // docker compose -p afk-<run-id> 的默认网络
```

**差异**：没有差异。同一个 provider 还有 `groups`（`--group-add`）、`devices`、`cpus`。设计不挂 docker socket 是对的，Sandcastle 默认也不挂。

### 6. `idleTimeoutSeconds`、`AbortSignal`（ADR 0004）

**API**：

- `idleTimeoutSeconds?: number`，默认 600，只要 agent 有输出就重新计时，超时抛 `AgentIdleTimeoutError`（`_tag: "AgentIdleTimeoutError"`，没有从包根导出，按 `_tag` 或 `name` 判断）。
- `signal?: AbortSignal`，`run()`、`sandbox.run()`、`wt.run()`、`interactive()` 都支持。中止时杀掉 agent 子进程，promise 以 `signal.reason` 拒绝，worktree 留在磁盘上，hooks 也会收到 signal（`pkg:dist/index.d.ts` 537–538、555–570，`src:docs/adr/0004-…`）。
- 还有 `completionTimeoutSeconds`（默认 60，ADR 0019）：看到完成信号后进程还挂着时，过了这个时间强制按成功结束。

```ts
const ac = new AbortController();
const t = setTimeout(() => ac.abort(new Error("wall-clock")), 60 * 60_000);
await run({ /* … */ idleTimeoutSeconds: 600, signal: ac.signal }).finally(() => clearTimeout(t));
```

**差异**：基本一致。有两点要补：

1. `createSandbox()` / `createWorktree()` 这两个工厂函数**不接受** signal（ADR 0004 有意这么设计）。
2. `sandbox.exec()` **既没有 signal 也没有超时**（`SandboxExecOptions` 只有 `onLine`、`cwd`、`sudo`、`stdin`，见 `pkg:dist/index.d.ts` 868–877）。

**对设计的影响（小改）**：门禁命令的墙钟上限要由 worker 自己加，比如用 `timeout <s> <cmd>` 包住命令，或者超时后直接 `sandbox.close()`。另外设计没写完成信号：AFK prompt 应该让 agent 在 `<result>` 之后输出 `<promise>COMPLETE</promise>`，或者传 `completionSignal: "</result>"`，这样 agent 进程挂住时 60 秒内就能收尾，不用等满 600 秒的 idle 超时。

### 7. `onAgentStreamEvent` 实时日志

**API**：`logging: { type: "file"; path: string; onAgentStreamEvent?: (e: AgentStreamEvent) => void; verbose?: boolean }`。事件有三种：`{ type: "text", message }`、`{ type: "toolCall", name, formattedArgs }`、`{ type: "raw", line }`，都带 `iteration` 和 `timestamp`。回调抛出的异常会被吞掉（`pkg:dist/index.d.ts` 244–270、456–478，`src:src/run.ts` 258–290）。`createSandbox` / `createWorktree` 也用同一个处理函数（`src:src/createSandbox.ts` 448、`src/createWorktree.ts` 657）。

```ts
logging: {
  type: "file",
  path: `${logDir}/${runId}.log`,
  onAgentStreamEvent: (e) => platform.appendRunLog(runId, e),
  verbose: true,
}
```

**差异**：只在 `type: "file"` 模式下触发，`stdout` 模式不会。cursor 下 `toolCall` 能识别出 Read、Write、Bash 和其他函数调用，其余内容在 `raw` 里。

**对设计的影响**：没有，按 file 模式接入即可。

### 8. `sandbox.exec` 跑门禁；跳过权限时是否传 `--force`

**`sandbox.exec`**：`exec(command, { onLine?, cwd?, sudo?, stdin? }): Promise<{ stdout, stderr, exitCode }>`。`cwd` 默认是沙箱里的仓库目录；非零退出码会返回、不会抛错。`onLine` 存在时，返回的 stdout/stderr 只保留最后 64KiB，可以用 `docker({ maxOutputTailChars })` 调整（`pkg:README.md`「createSandbox」、`pkg:dist/sandboxes/docker.d.ts`）。

```ts
await using sb = await createSandbox({ branch: `gate/${id}`, sandbox: docker({ imageName }) });
const r = await sb.exec(`timeout 1800 npm test -- --reporter=junit --outputFile=junit.xml`);
// JUnit 在宿主机上从 sb.worktreePath/junit.xml 读（docker 是 bind mount）
```

**`--force`**：AFK 运行时 Orchestrator 固定传 `dangerouslySkipPermissions: true`（`src:src/Orchestrator.ts` 141–146；`createSandbox` 中是 `src/createSandbox.ts` 631），cursor 据此在 print 和交互两种命令里都加 `--force`（`src:src/AgentProvider.ts` 853、865）。**除此之外没有任何和工作区信任相关的参数**；整个仓库里也搜不到和 Cursor 信任提示相关的处理。

**差异**：和设计写的“Sandcastle 跳过权限时会传 `--force`”一致。

**对设计的影响（小改）**：

- “Cursor 无头运行可能卡在工作区信任提示上”仍然要在 M0 实测，Sandcastle 没有任何专门处理。如果真的卡住，因为没有输出，600 秒后会被 idle 超时兜住。
- 门禁的超时见第 6 项。

### 9. docker 沙箱镜像怎么装 Cursor Agent CLI

**约定**：

- `sandcastle init --agent cursor --sandbox docker` 生成 `.sandcastle/Dockerfile`、`prompt.md`、`.env.example`、`.gitignore`（内容是 `.env`、`logs/`、`worktrees/`）和 `main.(m)ts`（`pkg:README.md`「sandcastle init」、`src:src/InitService.ts` 7–10）。
- cursor 的 Dockerfile 模板（`src:src/InitService.ts` 308–337）：`FROM node:22-bookworm`；装 `git curl jq`；用 `AGENT_UID` / `AGENT_GID` 两个 build-arg 把 `node` 用户改名为 `agent`；`RUN curl https://cursor.com/install -fsS | bash`；`ENV PATH="/home/agent/.local/bin:$PATH"`；`ENTRYPOINT ["sleep","infinity"]`。worktree 挂在 `/home/agent/workspace`（`src:src/SandboxFactory.ts` 134）。
- `.env.example` 里只有 `CURSOR_API_KEY=`，默认模型是 `composer-2`（`src:src/InitService.ts` 443–452）。
- 构建：`sandcastle docker build-image [--image-name] [--dockerfile]`，Linux 上会自动传 `--build-arg AGENT_UID=$(id -u) AGENT_GID=$(id -g)`。默认镜像名是 `sandcastle:<主 clone 目录名>`（`src:src/mountUtils.ts` 39–47）。

**差异**：没有差异。agent 的二进制名是 `agent`，Sandcastle 直接调用 `agent --print …`。

**对设计的影响**：

- 镜像在 worker 上按仓库构建，`docker({ imageName })` 要显式传，不要依赖目录名推断。
- 镜像必须用 worker 用户的 UID 构建，`docker()` 启动前会检查。
- 门禁需要的语言运行时也要装进同一个镜像。

## 额外发现（设计里没写，但影响较大）

1. **同一个 clone 上并发创建沙箱会互相删 worktree（上游 #849，OPEN）。** `run()`、`createSandbox()`、`createWorktree()`、`interactive()` 开始时都会调用 `pruneStale()`，它会删除 `.sandcastle/worktrees/` 下所有没在 `git worktree list` 里登记的目录。另一个运行如果正在 `git worktree add`，目录已经建好、还没登记，就会被删掉（`pkg:dist/chunk-VOG34SRF.js` 25376 起，`src:src/SandboxFactory.ts` 318）。修复 PR #861、#992 都还没合并。设计的「多需求并行」会让一个 worker 在同一个主 clone 上并发跑多张票，正好会触发这个问题。**对策**：worker 对“同一 clone 的工厂调用”加一把进程内互斥锁，并且只用 `createSandbox()` / `createWorktree()`，因为这两个调用在返回时 worktree 已经建好登记完；或者每个并发槽位用一个单独的 clone。这条也是选方案 B 的另一个理由。
2. **主 clone 的 `.git` 以读写方式挂进沙箱。** 在 worktree 模式下，`resolveGitMounts` 会把 worktree 的 `.git` 文件和**整个父 `.git` 目录**按宿主机上的原路径挂进容器（`src:src/SandboxFactory.ts` 260–288）。这一步必须读写，否则 agent 没法 commit。由此有三个后果：
   - agent 可以改主 clone 里的任何 ref，包括 `spec/*` 和别的 `agent/*`；
   - agent 可以改 `.git/config` 和 `.git/hooks/`，比如设置 `core.hooksPath`、`core.fsmonitor`，或者放一个 `post-commit` 钩子。之后宿主机上的 git 命令（worker 的 `rebase --exec`、Sandcastle 自己的 `git status`、`fetch`）就会**在宿主机上执行 agent 放进去的命令**；
   - 这和设计的“写权限只有 worktree 一处”不一致。

   **对策**：
   - worker 进程环境里设置 `GIT_CONFIG_COUNT=2`、`GIT_CONFIG_KEY_0=core.hooksPath`、`GIT_CONFIG_VALUE_0=/dev/null`、`GIT_CONFIG_KEY_1=core.fsmonitor`、`GIT_CONFIG_VALUE_1=false`。这样 Sandcastle 起的 git 子进程也会继承，需要 git ≥ 2.31；
   - 每次运行前后对 `git for-each-ref` 和 `.git/config` 做快照比较，有变化就判失败；
   - `spec/*` 以 origin 为准：合并前 fetch 并校验预期 SHA，`--force-with-lease` 本身已经能防止远端被覆盖。

   这一条只是读源码推出来的，没有实测，建议列入 M0。
3. **环境变量注入范围。** `.sandcastle/.env` 里声明了的变量才会从 `process.env` 里取值（`src:src/EnvResolver.ts` 49–70），所以 worker 进程里的 Git token 不会被整体带进沙箱。但如果目标仓库主 clone 里的 `.sandcastle/.env` 声明了 `GH_TOKEN` 之类的键，就会泄漏进去。worker 应该自己管理主 clone 的 `.sandcastle/.env`，只放 `CURSOR_API_KEY`，或者干脆不建这个文件，统一通过 `cursor(model, { env })` 传。另外，`-e K=V` 会让密钥出现在 `docker inspect` 的结果里。
4. **`.sandcastle/` 目录被两边共用。** Sandcastle 把运行时目录（`worktrees/`、`logs/`、`.env`、`patches/`）放在 `<cwd>/.sandcastle/` 下，设计又把 `gates.yaml`、`integration/compose.yaml` 放进仓库的 `.sandcastle/`。只要 `.sandcastle/.gitignore` 忽略了这些运行时目录（init 默认忽略前三个），两边就不冲突。保护路径 `.sandcastle/**` 的检查用的是 `merge-base..HEAD` 的 diff，也不受这些运行时目录影响。

## 建议对 `docs/design.md` 的修改

1. 「Git 操作规范 / 票分支」：去掉“重试时 Sandcastle 复用已有 worktree（ADR 0003）”里的隐含前提，改成“commits 在分支上，不会丢；worktree 只有在留下未提交改动时才会被复用，worker 在调用前到 `.sandcastle/worktrees/agent-<id>/` 存 diff 再丢弃”。
2. 「已知风险和坑」和设计里所有提到 ADR 0007 的地方：改成“Sandcastle 0.12.0 没有 worktree 锁（ADR 0007 未实现，PR #463 未合并），由平台按 (repo, ticket) 加锁，保证同一时间只有一个运行”。
3. 「Agent 与 skills 对接 / 结构化输出」：改成“按 `Output.object` 的规则由 worker 自己校验（最后一个 `<tag>`、去围栏、zod）”，或者明确只用顶层 `run({ output })`。同时写清 agent 运行和门禁分别用哪个 API（建议方案 B + 门禁另起新沙箱）。
4. 「Agent 与 skills 对接 / 密钥」：`copyToWorktree` 改成 `hooks.host.onWorktreeReady` 的 `cp` 命令，或者改用只读挂载。
5. 「单票执行流水线 / 上限」：补上门禁命令的超时（`timeout` 包裹，因为 `exec` 没有 signal），以及完成信号或 `completionTimeoutSeconds`。
6. 「Git 操作规范 / commit trailer」：说明补 trailer 在哪个工作区里做（方案 B 在 `close()` 前做，或者用 plumbing 重写）。
7. 「多需求并行」/「作业与恢复」：补上“同一 clone 的沙箱创建要串行”（#849）。
8. 「Git 操作规范 / 凭据」和「已知风险和坑」：补上“`.git` 以读写方式挂载，可能经 hooks 或 config 逃逸”及其对策。

## 仍需 M0 实测

- cursor stream-json 最后是否一定会输出 `type: "result"` 事件，`<result>` 标签能不能被稳定取出（设计里已有这一项）。
- Cursor 在容器里无头运行，只传 `--force` 会不会卡在工作区信任提示上（设计里已有这一项）。
- `.git` 读写挂载下，`GIT_CONFIG_*` 能不能挡住 hooks 和 fsmonitor（新增）。
- worker 在同一 clone 上并发创建沙箱，加锁之后是否还会出现 #849 描述的问题（新增）。
