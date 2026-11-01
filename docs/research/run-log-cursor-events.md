# Run 日志里 Cursor 事件流的实际形状

> 调研票：xxh171015/afk-platform#127（地图 #125）。调研日期：2026-11-01。
> 只做了文档和源码调查：没有起 worker、没有跑 Cursor Agent。下面的「会进 Run 日志」是按写入路径推出来的；「CLI 会写出哪些事件」来自锁定版本 CLI 的 print 模式源码。不决定页面怎么展示。

## 结论

Worker 存进 Run 日志的是**两路混在一个纯文本文件里**的内容，没有事件类型标签、没有前缀把它们分开：

1. **Cursor 的 stdout NDJSON**（`stream-json`）：Sandcastle 0.12.0 把 docker exec 的**每一行 stdout**当作 `{type:"raw", line}` 交给 worker；worker 原样上传（只做密钥打码和超长截断）。官方文档列出 `system` / `user` / `assistant` / `tool_call` / `result`。锁定版本 CLI（`2026.10.22-27dcf5f`，和 `.sandcastle/Dockerfile` 一致）在这条路径上还会写 `thinking`、`retry`、`connection`、`interaction_query`，以及 `system` 的 `background_shell_timeout` / `task_notification`。工具调用的 JSON 键是 `tool_call.readToolCall` / `shellToolCall` / `editToolCall` 这类 oneof 包装，**没有顶层 `name`**。这一版 CLI **没有** `writeToolCall`，也**没有**文档里的 `tool_call.function`。
2. **Worker 自己的说明行**：`stageLog` 写进去，纯文本，前缀固定（`implement:`、`gate:`、`merge:`、`e2e:`、`environment:`、`result:` 等）。门禁/e2e 的命令本身**不会**以 `$ ` 开头出现；出现的是 `gate: <name> exit <code> (<ms> ms)` 加上 `--- <name> ---\n<stdout+stderr>`。Git 命令的 stdout **不会**进 Run 日志。

原型 `classifyLogLine` 能对上的只有 **`type === "assistant"` 且文本在 `message.content[0].text`**。它认的顶层 `name`（`read_file` / `write` / `bash`）和 `$ ` 前缀，在真实 Run 日志里都对不上：工具行会落到「agent 说明」。Sandcastle 内部解析出来的 `{type:"tool_call", name:"Read"}` **不会**上传。

review / final-review 的两条轴（Standards 和 Spec）共用**同一份** job 的 Run 日志，两路 NDJSON 交错，行上没有轴标签。Spec 那条作为 `extraRuns` 另建 Run 行，但没有自己的日志文件。

## 来源

| 编号 | 来源 | 取得日期 / 版本 |
| --- | --- | --- |
| [W-loop] | 本仓库 `packages/worker/src/worker.ts`（`LogUploader`、`stageLog`、`logRaw`） | origin/main `ca527e1` |
| [W-exec] | 本仓库 `packages/worker/src/executor.ts` | 同上 |
| [W-raw] | 本仓库 `packages/worker/src/raw-log.ts` | 同上 |
| [W-api] | 本仓库 `packages/worker/src/api.ts`、`packages/api/src/http/log-routes.ts`、`packages/api/src/logs/log-store.ts` | 同上 |
| [W-main] | 本仓库 `packages/worker/src/main.ts` | 同上 |
| [P-sc] | 本仓库 `packages/pipeline/src/sandcastle.ts`、`packages/pipeline/src/agent.ts`、`packages/pipeline/src/gate.ts`、`packages/pipeline/src/integration-env.ts` | 同上 |
| [P-df] | 本仓库 `.sandcastle/Dockerfile`（`CURSOR_CLI_VERSION=2026.10.22-27dcf5f`） | 同上 |
| [SC] | npm `@ai-hero/sandcastle@0.12.0`（`npm pack`，只读） | 2026-11-01。文件：`dist/index.js`、`dist/index.d.ts`、`dist/sandboxes/docker.js` 所在 chunk `dist/chunk-CP3TYXZA.js` |
| [D-output] | https://cursor.com/docs/cli/reference/output-format.md | 2026-11-01 抓取 |
| [D-headless] | https://cursor.com/docs/cli/headless.md | 2026-11-01 |
| [D-params] | https://cursor.com/docs/cli/reference/parameters.md | 2026-11-01 |
| [CL] | https://cursor.com/docs/cli/changelog.md | 2026-11-01 |
| [CLI] | `https://downloads.cursor.com/lab/2026.10.22-27dcf5f/darwin/arm64/agent-cli-package.tar.gz` | 2026-11-01 下载。print 模式发射器在 `dist-package/8008.index.js`；protobuf 字段表在 `dist-package/index.js`（`ToolCall\|1 shell_tool_call…`、`ReadToolCall` / `ReadToolSuccess`） |
| [R-cli] | `docs/research/cursor-cli-headless.md`（分支 `research/cursor-cli-headless`，#3，2026-10-28） | 对照用 |
| [PROTO] | Lovable 控制塔原型 `src/lib/view-map.ts` 的 `classifyLogLine`（路径 `/Users/xuxinghua/Downloads/913e95a9-cb98-4785-8291-4749ef1ec061/src/lib/view-map.ts`） | 2026-11-01 阅读 |

## 1. 写入路径

Run 日志是 API 上按「这次 Run、这次 attempt」存的纯文本文件：`<logDir>/run-<id>/attempt-<n>.log`，上限 50 MiB。Worker 用 `POST /worker/runs/{id}/logs` 追加，单次 chunk ≤ 1 MiB。[W-api]

`appendLog` 在整个 worker 里只有一处调用：`processJob` 里的 `LogUploader`。[W-loop] Host 作业（`open-pr` / `host-sync` / `spec-cleanup` / `pr-ready`）走另一条分支，**不建 LogUploader，不写 Run 日志**。

### 两路进同一个 buffer

```
executeStage
  log     = stageLog     →  worker 自己的 stdout（带 `job <id>: `）＋ LogUploader.add
  logRaw  = rawLogSink(LogUploader.add)  →  只进 Run 日志
```

[W-loop] `stageLog` 把一行既打到 worker 控制台（`job ${job.id}: ${line}`），又 `upload.add(line)`。`LogUploader.add` 若行尾没有 `\n` 就补一个；已经含换行的整段（门禁步骤全文）作为一次追加写进去。每 5 秒 flush，阶段结束再 flush。上传失败不让阶段失败。

`logRaw` 不打 worker 控制台。[W-exec] 注释写明：「goes to the Run's log only, not to the worker's own output」。

### Cursor 那一路：stdout 行 → raw 事件 → onRawLine

Sandcastle 的 cursor provider 拼出的命令是：

```
agent --print --output-format stream-json --model '<model>' --force '<prompt>'
```

没有 `--stream-partial-output`，也没有 `--trust`。[SC `cursor()` `buildPrintCommand`；[R-cli] 已记录，2026-11-01 的 0.12.0 包里仍是这串]

AFK 的 `SandcastleAgentRunner.run` 打开 `logging: { type: "file", verbose: true, onAgentStreamEvent }`，回调里**只转发 `event.type === "raw"`** 的 `event.line`：[P-sc]

- 追加到 worker 磁盘 `sandbox-logs/…/<stage>.stream.jsonl`（完整、不截断）
- 再调用 `options.onRawLine(event.line)`

`verbose: true` 同时把同样的 raw 行写入 `<stage>.log`。[SC `buildAgentStreamHandler` / `buildVerboseRawLineSink`]

`event.line` 从哪来：Orchestrator 的 `invokeAgent` 对 `sandbox.exec` 设 `onLine`，**每一行 stdout**先 `onRawLine(line)`，再交给 `parseStreamLine`。[SC `dist/index.js` `invokeAgent`] Docker 实现里 `onLine` 只挂在 `proc.stdout` 的 readline 上；**stderr 不进 raw 事件**。[SC `chunk-CP3TYXZA.js` docker `exec`]

Worker 接到 `onRawLine` 之后：[W-exec][W-raw][W-main]

1. `sanitizeRawLine`：把 `CURSOR_API_KEY` 换成 `***`；超过 16 KiB 字符截断并加 ` [line cut]`
2. `rawLogSink`：累计超过 8 MiB 后不再上传后续 raw 行，只追加一次 `[raw events beyond the size limit are not uploaded]`
3. 这两步**只作用于 raw 路**。`stageLog` 的 worker 说明行不受 8 MiB / 16 KiB 限制（仍受 API 单 Run 50 MiB 限制）

磁盘上的 `<stage>.stream.jsonl` 是截断之前的原文；API 里的 Run 日志是打码、截断、封顶之后的副本。[W-raw] 注释原文：「Everything is kept in full on the worker's disk.」

### Sandcastle 解析的事件不上传

同一行 stdout，Sandcastle 还会 `parseCursorStreamLine`，得到内部事件 `{type:"text"|"result"|"tool_call"|"session_id"}`，用于自己的展示和 `Output.object`。这些解析结果走 `AgentStreamEvent` 的 `"text"` / `"toolCall"` 变体。[SC `dist/index.d.ts` `AgentStreamEvent`] AFK 的回调遇到非 `"raw"` 直接 return，所以 **Run 日志里没有 `name: "Read"` 这种解析后的形状**。[P-sc]

`parseCursorToolCallStarted` 只认 `subtype === "started"`，并且只认三种包装：[SC]

| 包装 | 内部 name | 参数 |
| --- | --- | --- |
| `tool_call.readToolCall.args.path` | `"Read"` | 路径字符串 |
| `tool_call.writeToolCall.args.path` | `"Write"` | 路径字符串 |
| `tool_call.function`（`arguments` 能 JSON.parse 且有 `command`） | `"Bash"` | 命令字符串 |
| `tool_call.function` 其它 | `fn.name` | `arguments` 原串 |

`tool_call` 的 `completed`、以及下面 CLI 源码里的 `shellToolCall` / `editToolCall` 等，Sandcastle **解析为空数组**，但 raw 行仍然上传。

### `onNote` 不进 Run 日志

`SandcastleConfig.onNote` 的注释写「things worth a line in the run log」，gate 沙箱在保留脏 worktree 时会调用它。[P-sc] `main.ts` 把它接到 worker 的 `console.log`，**不是** `stageLog`。[W-main] 所以「sandbox worktree kept uncommitted changes」这类句子只在 worker 控制台，不在 Run 日志。

Slot 重建、docker 清容器、lease 心跳、交结果失败，同样走 `options.log` / `SlotManager.log`，前缀是 `job <id>:` 或 `slot <n>:`，**不进 Run 日志**。[W-loop][W-main]

## 2. Cursor stream-json 的 type / 字段

官方规定：`--print --output-format stream-json` 输出 NDJSON，一行一个对象；成功时以 `result` 结束；失败时进程非 0 退出，流可能没有终端事件，错误在 stderr；`thinking` 在 print 模式被屏蔽；以后可能加字段，消费方应忽略不认识的。[D-output]

AFK 实际用的就是这个格式（见上一节的命令行）。没有 `--stream-partial-output`。[SC][D-params]

### 官方文档列出的五种（2026-11-01 仍与 [R-cli] 一致）

#### `system` / `subtype: "init"`（一次）

字段：`apiKeySource`（`env|flag|login`）、`cwd`、`session_id`、`model`（显示名）、`permissionMode`。文档说以后可能加 `tools`、`mcp_servers`。[D-output]

锁定 CLI 写出的 init 把 `permissionMode` **写死为 `"default"`**，即使命令带了 `--force`。[CLI `8008.index.js` print 模式：`permissionMode:"default"`]

#### `user`

```json
{"type":"user","message":{"role":"user","content":[{"type":"text","text":"<prompt>"}]},"session_id":"<uuid>"}
```

[D-output]。CLI 在 init 之后立刻写一行，`text` 是整段 prompt。[CLI]

#### `assistant`

```json
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"<complete message text>"}]},"session_id":"<uuid>"}
```

默认（无 `--stream-partial-output`）每次工具调用之间一条完整消息。[D-output]

CLI 实现：`textDelta` 先攒在缓冲区；工具开始前 flush 一条（带 `timestamp_ms`，若有则带 `model_call_id`）；终端 `result` 前再 flush 一条（不带 `timestamp_ms`）。[CLI] 这与文档「完整消息」一致，也解释了文档里 `--stream-partial-output` 那张「有 timestamp 无 model_call_id 才是新文本」的表——AFK 没开这个旗，不应按 delta 去拼。

#### `tool_call` / `subtype: "started" | "completed"`

官方示例字段：`call_id`、`tool_call`（包装对象）、`session_id`。[D-output]

官方点名的包装只有三个：

| 包装键 | started 的 `args` | completed 的 `result.success` |
| --- | --- | --- |
| `readToolCall` | `{path}` | `{content, isEmpty, exceededLimit, totalLines, totalChars}` |
| `writeToolCall` | `{path, fileText, toolCallId}` | `{path, linesCreated, fileSize}` |
| `function`（「其它工具」） | `{name, arguments}`（`arguments` 是字符串） | 未举例 |

[D-output] Headless 示例脚本也只判断 `readToolCall` / `writeToolCall`。[D-headless]

锁定 CLI 实际写出的对象还多了 `model_call_id`、`timestamp_ms`；completed 在开了 captureEnv 且工具是 shell 时可能多一个 `env` 字符串（AFK 没有打开这个选项）。`tool_call` 字段是 protobuf `ToolCall` 消息 `JSON.stringify` 的结果（`toJSON()` → `toJson({emitDefaultValues:true})`），oneof 以**已设置的那一个 camelCase 键**出现。[CLI]

这一版 `ToolCall` 的 oneof **没有 `write_tool_call`，也没有 `function`**。字段从 `shell_tool_call`、`read_tool_call`、`edit_tool_call` 等开始。[CLI `index.js` 模式串 `ToolCall|1 shell_tool_call #0 tool|…|8 read_tool_call|…|12 edit_tool_call|…`] JSON 键即：

`shellToolCall`、`deleteToolCall`、`globToolCall`、`grepToolCall`、`readToolCall`、`updateTodosToolCall`、`readTodosToolCall`、`editToolCall`、`lsToolCall`、`readLintsToolCall`、`mcpToolCall`、`semSearchToolCall`、`createPlanToolCall`、`webSearchToolCall`、`taskToolCall`，以及 MCP / 子 agent / 图像等一长串。**没有 `writeToolCall`。** 改文件走 `editToolCall`。官方文档的 `writeToolCall` / `function` 与这一版 CLI 对不上。

和四类动作有关的 args（UI 源码与 protobuf 字段名一致的部分）：

| 包装 | 用来分类的 args | 依据 |
| --- | --- | --- |
| `readToolCall` | `args.path`（另有 `offset`、`limit`） | [D-output]；[CLI] `ReadToolArgs\|1 path` |
| `editToolCall` | `args.path` | [CLI] UI：`editToolCall` → `Editing ${path}` |
| `shellToolCall` | `args.command` | [CLI] UI：`shellToolCall` → `n?.command` |
| `grepToolCall` | `args.pattern`、`args.path` | [CLI] UI |
| `globToolCall` | `args.globPattern`、`args.targetDirectory` | [CLI] UI；protobuf `GlobToolArgs\|1 target_directory\|2 glob_pattern` |
| `lsToolCall` / `deleteToolCall` | `args.path` | [CLI] UI |

Read 完成态：protobuf `ReadToolSuccess` 有 `content`、`isEmpty`、`exceededLimit`、`totalLines`、`fileSize`、`path` 等，**没有**文档里的 `totalChars`。[CLI] 文档示例仍写 `totalChars`。[D-output]

每个包装内部形状是 `{args, result}`；`result` 是 `{success: …}` 或 `{error: …}` 一类 oneof（与 [D-output] 的 `result.success` 写法相容）。

#### `result`（成功时最后一行）

文档字段：`type:"result"`、`subtype:"success"`、`is_error:false`、`duration_ms`、`duration_api_ms`、`result`（所有 assistant 文本拼接，段之间无分隔符）、`session_id`、可选 `request_id`。[D-output]

CLI 在此之上，若本轮 `turnEnded` 带了 token 计数，会加上：

```json
"usage": {
  "inputTokens": 0,
  "outputTokens": 0,
  "cacheReadTokens": 0,
  "cacheWriteTokens": 0
}
```

`inputTokens` 会减去 cache 读写后再写出。[CLI] 官方 [D-output] **仍然没有** usage 字段。Changelog 从 2026-02 起声称 stream-json 里有 per-turn token 和 `request_id`。[CL] 这回答了 [R-cli]「usage 字段名未确认」：在锁定 CLI 里它挂在终端 `result` 上，键名是上面四个。Sandcastle 的 cursor parser **不读** `usage`，`parseSessionUsage` 也未实现；AFK worker 也不从日志里提取进 `runs.token_usage`。

失败：文档说非 0 退出、可能没有 `result`、错误在 stderr。[D-output] stderr 不进 raw 事件；Sandcastle 会把 stderr（否则最后 20 行 stdout）放进抛出的 `AgentError` 消息。[SC] Worker 若把它记成阶段结论，会以 **`stageLog` 文本行**出现（见第 4 节），不是 NDJSON。

### CLI 源码里多出来的 type（官方文档未列）

print 模式在 `O`（stream-json）为真时还会 `stdout.write`：[CLI `8008.index.js` `sendUpdate` / 后台任务循环]

| `type` | `subtype` | 何时 |
| --- | --- | --- |
| `thinking` | `delta` / `completed` | 收到 thinking 消息时。文档写 print 模式屏蔽 thinking；**源码仍会写**。是否出现取决于这次 Run 有没有 thinking 消息 |
| `retry` | （动态） | 推理重试开始 |
| `connection` | （动态） | 连接状态 |
| `interaction_query` | `request` / `response` | 无头询问（web search 等）；`--force` 下会自动答 |
| `system` | `background_shell_timeout` | 墙钟后仍有后台 shell 被掐掉 |
| `system` | `task_notification` | 后台任务完成通知 |

这些行同样进 Run 日志（只要出现在 stdout）。Sandcastle 全部当未知行忽略，只原样转发。

## 3. 和 `research/cursor-cli-headless` 的对照

[R-cli] 第 4 节记录的五种事件、`readToolCall` / `writeToolCall` / `function`、`result` 无分隔拼接、thinking 被屏蔽、usage 字段名未知——前半仍与 2026-11-01 的 [D-output] 一致。

对 **AFK 锁定的 CLI 2026.10.22-27dcf5f** 需要补的差异：

- usage 在 `result.usage.{inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens}`，外加已有的 `request_id`。[CLI]
- 改文件的包装是 `editToolCall`，不是文档/Sandcastle 的 `writeToolCall`。[CLI]
- 「其它工具」不是 `function`，而是各自的 `*ToolCall` 键。[CLI]
- thinking / retry / connection 等 type 在 CLI 源码里会写到 stdout；文档仍说 thinking 被屏蔽。[CLI] vs [D-output]
- `tool_call` 行带 `timestamp_ms`、`model_call_id`，即使没开 `--stream-partial-output`。[CLI]

Sandcastle 0.12.0 的 parser 仍停在 [R-cli] 那三套包装上；这不影响上传（上传的是 raw），只影响 Sandcastle 自己的 tool 展示。

## 4. 混入的非 agent 行

全部来自 `stageLog`（= `context.log`），UTF-8 文本，**不以 `{` 开头**（除非碰巧内容如此）。阶段结束固定多一行 `result: <stage> <outcome>`。[W-loop]

### Agent 阶段（implement / gate-fix / review-fix / merge-fix / final-fix）

- `restart: dropped <branch> (was <sha>)`（仅 restart）
- `<stage>: running the agent on <branch>`
- 然后是 Cursor NDJSON
- `<stage>: <outcome>`，失败时括号里带 `classifyAgentRun` 的 detail（可能含 Sandcastle 拼进的 stderr）
- `extra ref in the slot, not taken back: <ref>`（`retrieveResult`）

Git 的 fetch / commit / stamp / push **不写日志**。`retrieveResult` 只在 slot 里出现意外 ref 时打一行。[W-exec]

### Review / final-review

没有「running the agent」行。两条轴 `Promise.all` 同时 `run()`，共用同一个 `onRawLine` → 同一份 Run 日志，**行上没有 `standards` / `spec` 标记**。[W-exec] 结束后：

- `review:` 或 `final-review: <outcome>`
- 若某轴有 commit：`review: WARNING the <axis> review made N commit(s); it should only read`

API 把 Spec 轴记成 `extraRuns` 另一条 Run，**不给它单独的 log 文件**；`appendLog` 只用 bundle 里那条（claim 时建的、Standards）Run id。[W-loop][W-exec]

### Diagnose

与 implement 类似，另有 `diagnose: WARNING the agent made N commit(s); …`。[W-exec]

### Gate（以及 merge 里对候选 / 已合并 head 的门禁）

- `gate: protected paths changed without approval: …`
- `gate: contract copies are wrong: …`
- 每个步骤：`gate: <name> exit <code> (<ms> ms)`
- 紧接着：`--- <name> ---\n` + `sandbox.exec` 的 **stdout+stderr 全文**。[P-sc][W-exec][P-sc `gate.ts` `stepLogs`]

命令字符串（`.sandcastle/gates.yaml` 的 `run`）**不会**出现在 Run 日志里，只有步骤名。没有 `$ ` 前缀。步骤输出里可以是任何文本，包括测试打印的 JSON。

### E2e

同样：`e2e: <name> exit …` 和 `--- <name> ---\n<输出>`。[W-exec]

### Merge

- `merge: <agent> is already part of <integration>`
- `merge: conflict in <files>`
- `merge: <integration> is now <sha>`
- `merge: the merged head could not be measured (…)`
- `merge: the merged head does not pass the gate; …`
- `<stage>: the integration branch moved, fetching and trying again (…)`
- `<stage>: the fix changes protected paths: …`（final-merge）

候选门禁的步骤日志同样走 `logGate`，所以 merge 的 Run 日志里会有 `gate:` 行。[W-exec]

### 联调环境（integration / diagnose / e2e）

- `environment: building <service> of <repo>`
- `environment: compose up <services>`
- `environment: <seed>`
- `environment: taking down <project>, left by a worker that stopped`
- `<label>: environment <project> is up after <ms> ms`

[P-sc `integration-env.ts`][W-exec] Compose 失败的错误正文走 `InfrastructureError` → worker `failed:` 控制台和 `api.fail`，**不是** `stageLog`。

### Raw 路自己加的一行

`[raw events beyond the size limit are not uploaded]`[W-raw]

以及被截断的 Cursor 行末尾 ` [line cut]`（这一行本来是 JSON，截断后不再是合法 JSON）。

### 不在 Run 日志里的

Worker 控制台：`job <id>: the lease is gone`、heartbeat、`failed:`、交结果重试、`slot n:`、host 作业、`onNote`。Git 命令输出。门禁/e2e 的命令行原文。

## 5. 原型 `classifyLogLine` 对得上什么

原型（[PROTO] 约 189–212 行）对每一行：

1. 以 `$` 开头 → 「运行命令」，摘要去掉 `$ `
2. `JSON.parse` 成功则看顶层 `name`、`type`、可选 `summary`：
   - `type === "tool_call"` 或 `name` 非空时：`read_file`/`read` → 读取；`write`/`strreplace`/`str_replace`/`edit`/`write_file` → 修改；`bash`/`shell`/`exec` → 运行命令
   - `type === "assistant"` → 「agent 说明」，文本取 `message.content[0].text`
3. 否则整行当「agent 说明」

对照真实日志：

| 原型规则 | 真实 Run 日志 | 对得上？ |
| --- | --- | --- |
| `$ …` → 运行命令 | worker / 门禁都不写 `$ ` | 否。门禁命令不会被认成「运行命令」 |
| 顶层 `name: "read_file"` / `"read"` | 读取在 `tool_call.readToolCall`，无顶层 `name` | 否 |
| 顶层 `name` 为 `write` / `edit` / `write_file` 等 | 锁定 CLI 是 `tool_call.editToolCall`，无 `writeToolCall`、无顶层 `name` | 否 |
| 顶层 `name` 为 `bash` / `shell` / `exec` | 命令在 `tool_call.shellToolCall.args.command` | 否 |
| `type === "tool_call"` 但 `name` 为空 | 进入 `if` 后三个 name 分支都不中，落到最后的「agent 说明」 | 工具行会显示成 agent 说明 |
| `type === "assistant"` + `message.content[0].text` | 与 [D-output] / CLI 一致 | **是**（完整消息，不是 delta） |
| `obj.summary` | Cursor 事件没有这个字段 | 用不上，退回整行 JSON |
| 非 JSON | worker 前缀行、门禁 dump、`result: …`、截断行 | 全部变成「agent 说明」 |
| `system` / `user` / `result` / `thinking` / `retry` | 能 parse，但没有对应分支 | 「agent 说明」，摘要是整段 JSON |
| Sandcastle 解析后的 `{type:"tool_call", name:"Read"}` | **不出现在 Run 日志里** | 原型若按这个写，是对着解析结果，不是对着上传内容 |

测试里的假 agent 曾上传 `{"type":"assistant","text":"working on it"}`（`packages/api/src/worker-demo/worker-demo.test.ts`），那是测试夹具，**不是** Cursor 的 `message.content` 形状。

和四类动作的事实对应（若按 Cursor 事件而不是原型函数来对齐）是：

| 原型四类 | 应对着的真实行 |
| --- | --- |
| 读取 | `tool_call` + `tool_call.readToolCall`（started/completed 各一行） |
| 修改 | `tool_call` + `tool_call.editToolCall`（文档里的 `writeToolCall` 在此 CLI 不存在） |
| 运行命令 | `tool_call` + `tool_call.shellToolCall`；**加上** worker 的 `gate:` / `e2e:` 步骤行（不是 agent 工具） |
| agent 说明 | `assistant` 的 `message.content[].text`；`result.result` 是全文拼接，不是逐步说明 |

`grepToolCall` / `globToolCall` / `lsToolCall` / `semSearchToolCall` 等没有对应的第四类以外的桶；按原型函数会进「agent 说明」。

## 6. 两路能不能分开（只列事实）

可以按行做机械划分，现有代码没有做：

- Cursor 事件：`JSON.parse` 成功，且 `type` 为 CLI 会写的那些（至少文档五种；锁定 CLI 还有 `thinking` / `retry` / `connection` / `interaction_query`）。
- Worker 行：其余文本。已知前缀：`restart:`、`<stage>:`（stage 为 implement / gate-fix / review / …）、`gate:`、`e2e:`、`merge:`、`diagnose:`、`environment:`、`review:`、`extra ref in the slot`、`result:`、`---`、`[raw events beyond`。

限制（都是源码里已经成立的，不是产品选择）：

1. 门禁/e2e 的 `--- name ---` 后面是命令输出，里面可以出现 JSON 对象，会被误判成 Cursor 事件。
2. 超过 16 KiB 的 raw 行带 ` [line cut]`，不再是合法 JSON。
3. review 两轴的 NDJSON 交错，分开后仍然分不清是哪一条轴。
4. `stageLog` 一次可以写入含多行的块（门禁全文），和 Cursor 的「一行一事件」不是同一种粒度。
5. stderr、git 输出、host 作业本来就不在这个文件里，不存在「从事件流里拆 git」的问题。
