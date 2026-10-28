# Cursor Agent CLI 无头模式在容器里的行为

> 调研票：xxh171015/afk-platform#3（地图 #1）。调研日期：2026-10-28。
> 只做了文档和源码调查：这台机器没有 Docker 和 Cursor CLI，下面的结论都没有实际跑过。标"**未确认，需 M0 实测**"的项要在 M0 第一天验证。

## 结论

能跑，没有发现挡路的问题。Sandcastle 的 `cursor()` provider 实际执行的是 `agent --print --output-format stream-json --model <m> --force '<prompt>'`。按 Cursor 官方 changelog，`--force` 能通过无头模式的信任检查。官方文档列出的 skills 目录里没有 `/skills`，所以设计里的 `/skills` 挂载点不会被自动发现；要么改挂到 `~/.cursor/skills`，要么继续在 prompt 里写明 SKILL.md 的路径让 agent 去读，两种做法可以同时用。`stream-json` 最后的 `result` 事件里有完整的 assistant 文本，Sandcastle 的 `Output.object` 就是从这段文本里找最后一个标签，所以结构化输出这条路走得通。按 changelog，用量数据会出现在 stream-json 里，但字段名没有文档，Sandcastle 也不解析，需要 worker 自己从原始行里取。

## 来源

| 编号 | 来源 | 取得日期 / 版本 |
| --- | --- | --- |
| [D-install] | https://cursor.com/docs/cli/installation.md | 2026-10-28 抓取 |
| [D-auth] | https://cursor.com/docs/cli/reference/authentication.md | 2026-10-28 |
| [D-params] | https://cursor.com/docs/cli/reference/parameters.md | 2026-10-28 |
| [D-headless] | https://cursor.com/docs/cli/headless.md | 2026-10-28 |
| [D-output] | https://cursor.com/docs/cli/reference/output-format.md | 2026-10-28 |
| [D-config] | https://cursor.com/docs/cli/reference/configuration.md | 2026-10-28 |
| [D-skills] | https://cursor.com/docs/skills.md | 2026-10-28 |
| [D-runmodes] | https://cursor.com/docs/agent/security/run-modes.md | 2026-10-28 |
| [D-admin] | https://cursor.com/docs/account/teams/admin-api.md（`/teams/filtered-usage-events`） | 2026-10-28 |
| [D-models] | https://cursor.com/docs/models-and-pricing.md | 2026-10-28 |
| [CL] | https://cursor.com/docs/cli/changelog.md（最新条目 v2026.10.22） | 2026-10-28 |
| [INSTALL-SH] | `curl https://cursor.com/install` 的脚本内容 | 2026-10-28，脚本里写死的版本是 `2026.10.22-27dcf5f` |
| [F-152476] | https://forum.cursor.com/t/cursor-cli-headless-mode-doesnt-load-skills-from-known-locations/152476 | 帖子时间 2026-02-21 ~ 03-11 |
| [F-155358] | https://forum.cursor.com/t/skills-in-agents-skills-are-not-loaded-by-the-cli/155358 | 2026-03-20 ~ 03-26 |
| [F-159218] | https://forum.cursor.com/t/skills-not-shown-in-cursor-cli-while-visible-and-working-in-desktop-app/159218 | 2026-04-28 ~ 05-10 |
| [F-162011] | https://forum.cursor.com/t/trust-for-interactive-cursor-agent-or-auto-trust-new-workspaces-in-cli/162011 | 2026-05-31 |
| [F-152090] | https://forum.cursor.com/t/cursor-cli-limitations-headless/152090 | 2026-02-17 |
| [SC] | Sandcastle 本地 clone `/root/workspace/sandcastle`，HEAD `a53e227`（2026-10-19），包版本 0.12.0 | 文件：`src/AgentProvider.ts`、`src/Orchestrator.ts`、`src/run.ts`、`src/extractStructuredOutput.ts`、`src/sandboxes/docker.ts`、`src/InitService.ts`、`CHANGELOG.md` |

论坛帖由 WebFetch 摘要后阅读，没有逐字核对原帖。

## 1. 安装、版本锁定、认证

**事实**

- 官方安装方式是 `curl https://cursor.com/install -fsS | bash`，装到 `~/.local/bin/agent`，需要把 `~/.local/bin` 加进 PATH [D-install]。Sandcastle `init` 生成的 cursor Dockerfile 用 `node:22-bookworm`，以非 root 的 `agent` 用户执行这条命令，再设 `ENV PATH="/home/agent/.local/bin:$PATH"` [SC `src/InitService.ts` 的 `CURSOR_DOCKERFILE`]。
- 安装脚本本身写死了一个版本：它从 `https://downloads.cursor.com/lab/<version>/<linux|darwin>/<x64|arm64>/agent-cli-package.tar.gz` 下载，解压到 `~/.local/share/cursor-agent/versions/<version>/`，再把 `~/.local/bin/agent` 和 `~/.local/bin/cursor-agent` 两个软链指过去 [INSTALL-SH]。2026-10-28 当天的版本是 `2026.10.22-27dcf5f`。同一天用 HEAD 请求试了较老的 `2026.02.13-41ac335`，也返回 200，说明旧版本的 tarball 还能下载。官方没有承诺旧版本会一直保留。
- 默认会自动更新 [D-install]。2026 年 1 月的 changelog 加了 `--disable-auto-update`，用来关闭后台更新 [CL "January 2026"]，但参数表 [D-params] 里没有列这个参数。
- 认证：在 Dashboard → API Keys 生成 user API key，通过环境变量 `CURSOR_API_KEY` 传入（推荐）或用 `--api-key` [D-auth]。stream-json 的 `system/init` 事件里有 `apiKeySource: "env|flag|login"` [D-output]，可以用来确认读到的是环境变量。`agent status --format json` 可以检查认证状态 [D-params][CL "April 2026"]。
- 代理：支持 `HTTP_PROXY`/`HTTPS_PROXY`/`NODE_USE_ENV_PROXY=1`，TLS 被中间人检查时用 `NODE_EXTRA_CA_CERTS`。代理不支持 HTTP/2 时，在配置里设 `network.useHttp1ForAgent: true` [D-config]。
- 团队管理员可以在组织范围内禁用无头模式 [CL v2026.06.09 "Admins can disable headless mode"]。

**写进镜像的建议**

```dockerfile
# 锁定版本：直接下载指定版本的 tarball，不走安装脚本
ARG CURSOR_CLI_VERSION=2026.10.22-27dcf5f
RUN mkdir -p ~/.local/share/cursor-agent/versions/$CURSOR_CLI_VERSION ~/.local/bin \
 && curl -fsSL "https://downloads.cursor.com/lab/$CURSOR_CLI_VERSION/linux/x64/agent-cli-package.tar.gz" \
    | tar --strip-components=1 -xzf - -C ~/.local/share/cursor-agent/versions/$CURSOR_CLI_VERSION \
 && ln -sf ~/.local/share/cursor-agent/versions/$CURSOR_CLI_VERSION/cursor-agent ~/.local/bin/agent
ENV PATH="/home/agent/.local/bin:$PATH"
```

运行时只注入 `CURSOR_API_KEY`（`cursor(model, { env })`，[SC `CursorOptions.env`]）。

**未确认，需 M0 实测**

- 容器运行时会不会自动更新、能不能关掉。容器是一次性的，更新只会落在本次容器里，但会让实际运行的版本和锁定的版本不一致。`--disable-auto-update` 在 Sandcastle 固定拼出来的命令里加不进去，在 `cli-config.json` 里有没有对应的配置项也没查到。
- 只设 `CURSOR_API_KEY`、没有 keychain 的 Linux 容器里，会不会因为写凭据失败而报错。Docker 官方的 sbx cursor kit 设了 `AGENT_CLI_CREDENTIAL_STORE=memory`（来源 hub.docker.com/r/docker/sbx-kit-cursor-mixin，属于第三方，Cursor 文档里没有）。
- PoC 用的账号所在团队有没有禁用无头模式。

## 2. 工作区信任提示

**事实**

- 2026 年 1 月起："Non-interactive runs in untrusted workspaces fail with guidance unless `--trust` (or `--force`) is passed." [CL "January 2026"]。也就是说，无头模式碰到不受信任的工作区会**直接失败**，不会卡住等待输入；传 `--trust` 或 `--force` 都能通过检查。
- 2026 年 2 月："`--yolo`. Fully autonomous runs that auto-approve consistently across trust, MCP, and command approvals." [CL "February 2026"]。`--yolo` 是 `--force` 的别名 [D-params]。
- `--trust` 的说明是 "Trust the workspace without prompting (headless mode only)" [D-params]。v2026.07.20 起交互模式也能用 [CL]。
- Sandcastle 的 Orchestrator 在 print 模式下总是传 `dangerouslySkipPermissions: true` [SC `src/Orchestrator.ts`]，所以 cursor provider 实际执行的命令总是带 `--force`、不带 `--trust` [SC `src/AgentProvider.ts` `buildPrintCommand`]。git 历史显示，provider 最早的写法是 `--yolo`/`--trust` 二选一（5f249f5，2026-04-22），后来改成只传 `--force`（fea0d91，2026-05-02）。
- `--force` 对应 Run Everything 模式，这个模式不启用 Cursor 自己的 Landlock/seccomp 沙箱 [D-runmodes]，所以不会和 Docker 的隔离冲突。
- v2026.07.13 起，`.cursor/worktrees.json` 里的 setup 命令只在工作区受信任后才运行 [CL "Worktree setup respects workspace trust"]。我们不用它，影响不大。
- 用户可以在 `~/.cursor/cli-config.json` 里设 `attribution.attributeCommitsToAgent`，它默认是 `true`，会给 agent 的 commit 加 "Made with Cursor" trailer [D-config]。这跟信任无关，但和 M0 里"补 trailer"的门禁有关：建议在镜像里放一份 `cli-config.json`，把它设成 `false`；或者门禁允许这个 trailer 存在。

**未确认，需 M0 实测**

- 在 Sandcastle 的 docker 里，只带 `--force`、不带 `--trust` 时到底会不会出现信任检查。按 changelog 是不会；另有一份第三方说法（Docker sbx kit 的文档）认为 `--yolo` 跳不过信任检查，要事先在 `~/.cursor/projects/<slug>/` 写入信任标记，这和官方 changelog 矛盾。如果实测会失败，有两个绕法：
  1. 在镜像里放一个包装脚本：PATH 最前面放一个 `agent`，它给真实的二进制追加 `--trust` 再执行；
  2. 给 Sandcastle 写一个自定义 provider，在命令里加上 `--trust`。
- 信任检查失败时退出码是不是非 0、错误是写到 stderr 还是 stdout。Sandcastle 优先报告 stderr [SC `Orchestrator.ts`]。

## 3. skills 加载

**事实**

- 官方文档列的自动发现目录 [D-skills]：
  - 项目级：`.agents/skills/`、`.cursor/skills/`，以及仓库里任意子目录下的这两个目录，只对该子目录下的文件生效
  - 用户级：`~/.agents/skills/`、`~/.cursor/skills/`
  - 兼容其他工具的目录：`.claude/skills/`、`.codex/skills/`、`~/.claude/skills/`、`~/.codex/skills/`

  **`/skills` 不在其中**。
- 论坛帖 [F-152476]：2026-02-21 报告 `agent -p` 不加载项目里的 `.cursor/skills`，版本 `2026.02.13-41ac335`。员工 Colin 在 2026-03-09 21:43 回复 "We've pushed a change… The CLI should now be able to see your skills"，**没有给出版本号**。报告人 03-11 确认可用。
- 正式版本里有据可查的说法：2026-05-07 的 changelog 写了 "**Skills everywhere.** Skills load in interactive, headless, and editor-integration modes; `/skill-name` invocations work in `-p` print mode." [CL "May 7, 2026"]。所以至迟在 2026-05-07 的正式版本里，无头模式已经能加载 skills，当前版本 v2026.10.22 也包含在内。03-09 那次修复具体对应哪个版本号，没查到。
- 后续相关的修复 [CL]：
  - 2026 年 3 月：支持 `.claude/skills`、`.agents/skills`、`.codex/skills`
  - 2026-05-14：子目录里的 `.cursor/skills` 也能被发现
  - v2026.06.22：会跟随软链目录
  - v2026.08.11："Skill discovery skips hidden directories"，扫描时不再进入以点开头的隐藏子目录
  - v2026.10.08：`/skills` 会对违反规范的 skill 给出警告：name 和文件夹名不一致、description 超过 1024 字符、正文超过约 5000 token
- 遗留问题 [F-155358][F-159218]：CLI 的 `/` 斜杠菜单和 agent 上下文用的是两套加载逻辑。`~/.agents/skills` 能被 agent 上下文加载，但一度不在斜杠菜单里（员工 03-26 说下个版本修）。员工给的绕法都是复制或软链到 `~/.cursor/skills/`。插件里带的 skills 在 CLI 中注册不上，截至 2026-05-10 没有排期。
- frontmatter 规则 [D-skills]：
  - `name` 只能用小写字母、数字和连字符，必须和所在文件夹同名
  - `disable-model-invocation: true` 的 skill 只能通过 `/skill-name` 显式调用
  - `user-invocable: false` 会把 skill 从斜杠命令里隐藏，但模型仍然可以用 [CL v2026.07.06]
- 能不能按路径读 SKILL.md：skill 本质上就是普通文件，agent 有 Read 工具，在 Run Everything 模式下读文件不需要审批，读取范围也不限于工作区 [D-runmodes 里的读权限边界只对沙箱模式生效]。所以在 prompt 里写"读 `/skills/tdd/SKILL.md` 并照做"一定可行，只是能读到不代表 agent 一定会照着做。

**建议**

- 把 skills 目录只读挂载到 `/home/agent/.cursor/skills`，而不是 `/skills`。这是文档里的用户级目录，也是员工推荐的位置；挂进工作树会把文件混进仓库。prompt 里同时写明绝对路径 `/home/agent/.cursor/skills/<name>/SKILL.md`，作为兜底。
- 挂进去的必须是真实目录。设计里已经写了"symlink 在容器里是断链"，挂载时要在宿主机侧先解析软链。
- 自己写的 skill 要满足"name 和文件夹同名"，否则可能加载不上或者被警告。

**未确认，需 M0 实测**

- 挂载到 `~/.cursor/skills` 后，在 `agent -p` 里能不能被自动发现。验证方法：在 prompt 里要求 agent 列出它看到的 skills，或者调用 `/tdd`，看输出里有没有约定的标记字符串（参考 [F-152476] 里员工的复现方法）。
- 设了 `disable-model-invocation` 的 skill（triage、implement）在 `-p` 模式下用 `/name` 调用能不能生效。设计里本来就打算把这些步骤直接写进 AFK prompt，所以这一项不影响 M0。

## 4. stream-json 和结构化输出

**事实** [D-output]

- 输出是 NDJSON，一行一个事件，依次是：
  - `system/init`：带 `cwd`、`session_id`、`model`（显示名）、`apiKeySource`、`permissionMode`
  - `user`
  - `assistant`：每段 assistant 消息一行，也就是两次工具调用之间的完整文本
  - `tool_call`：分 `started` 和 `completed` 两种，工具体放在 `readToolCall`、`writeToolCall` 或 `function` 里
  - 最后一行是 `result`：`{"type":"result","subtype":"success","is_error":false,"duration_ms","duration_api_ms","result":"<full assistant text>","session_id","request_id"}`
- `result` 字段是"所有文本 delta 的拼接"，**段与段之间没有分隔符**（官方示例里就是 `"…the README.md fileBased on the README…"`）。
- 失败时进程以非 0 退出，流可能在没有 `result` 事件的情况下中途结束，错误写到 stderr。
- 思考（thinking）事件在 print 模式下被屏蔽，所以模型长时间思考时 stdout 上不会有任何输出。
- 文档说明以后可能增加字段，消费方要忽略不认识的字段。
- Cursor 本身没有类似 JSON schema 约束输出的参数 [D-params 中没有；F-152090 的用户在 2026-02 也提到 "doesn't support JSON schema structured responses"]。

**Sandcastle 怎么用这些事件** [SC]

- `parseCursorStreamLine` 处理三类事件：从 `tool_call/started` 里取工具名和参数用于显示；把 `assistant` 当作 `text`；从 `result` 里取 `result` 字段。`system/init` 里的 `session_id` 也会取出，但因为 `captureSessions: false`，并不用来续接会话。
- Orchestrator 返回 `{ result: resultText || execResult.stdout }`。`run()` 在 `options.output` 存在时调用 `extractStructuredOutput`：在这段文本里找**最后一个** `<tag>…</tag>`，去掉 Markdown 代码围栏，执行 `JSON.parse`，再用 Standard Schema（zod）校验。失败时抛出 `StructuredOutputError`。
- 对 cursor 不能用 `maxRetries > 0`（会直接报错），因为重试需要续接会话 [SC README/CHANGELOG 0.12.0]。
- 默认空闲超时 600 秒，每收到一行输出就重新计时 [SC `Orchestrator.ts` `DEFAULT_IDLE_TIMEOUT_SECONDS`]。

**结论**：最后一条消息能可靠取出。`result` 事件里有完整文本，Sandcastle 取的是最后一个标签，所以中途出现的文字不影响。段之间没有分隔符也不影响按标签提取。

**风险**

- 进程以 0 退出但没有输出 `result` 事件时（文档没说会不会出现），Sandcastle 会退回到原始 stdout，也就是 NDJSON。这时标签在 JSON 字符串里，换行被转义成 `\n`，`JSON.parse` 很可能失败，结果被判成 `invalid-output`。这个结果本身是对的，只是原因会被误读。
- 思考时没有输出，加上 600 秒的空闲超时，长时间推理可能被误判为卡死。建议 M0 先保留默认值，同时加墙钟上限。

**未确认，需 M0 实测**：在 cursor provider 下 `Output.object` 能不能拿到结构化输出（设计里"待验证事项"的第 3 条）。

## 5. 用量和费用

**事实**

- 2026 年 2 月的 changelog："**Token usage for scripts.** Per-turn input/output/cache token totals and a `request_id` in `stream-json` output; headless transcripts write Claude Code-compatible JSONL." [CL "February 2026"]。**但 [D-output] 的事件结构里没有任何 usage 字段**，所以字段名和它出现在哪个事件里都不清楚。
- Sandcastle 的 cursor provider 不产生 `usage` 事件，也没有 `parseSessionUsage`。测试里明确断言后者是 `undefined` [SC `AgentProvider.test.ts`]。所以 `iterations[].usage` 拿不到值。不过 `logging: { type: "file", onAgentStreamEvent }` 会把每一行原始 stdout 作为 `{type:"raw", line}` 推出来 [SC `src/run.ts`、`AgentStreamEmitter.ts`]，worker 可以自己解析 usage、`session_id`、`request_id` 和 `duration_ms`。
- 2026 年 3 月的 changelog 说 hooks 的 payload 里加了每轮的 token 用量 [CL "March 2026"]，但 hooks 文档里只写了 `context_tokens` 和 `context_usage_percent` 这类上下文窗口指标。
- 团队 Admin API 的 `POST /teams/filtered-usage-events` 按事件返回：
  - `tokenUsage{inputTokens,outputTokens,cacheWriteTokens,cacheReadTokens,totalCents}`
  - `chargedCents`、`model`、`isHeadless`、`conversationId`

  其中 `conversationId` 是 "ID of the conversation (agent session)"，可以和其他数据关联。限制：数据按小时聚合，建议最多每小时拉一次，每个团队每分钟限 60 次，用 Admin API key 走 Basic Auth，需要 Teams/Enterprise 账号 [D-admin]。
- CLI 里的 `/usage` 只在交互模式下显示整个账户的套餐用量 [CL v2026.07.13]，按次运行的用量不在这里。

**建议**：M0 先按设计记录运行时长和次数。worker 把原始 stream-json 行存进运行日志，事后从中提取 usage 字段（如果有）和 `session_id`。如果账号属于 Teams，可以每小时按 `conversationId` 从 Admin API 补回费用。

**未确认，需 M0 实测**

- stream-json 里 usage 字段的实际名字和位置。
- `session_id` 和 Admin API 的 `conversationId` 是不是同一个值。
- PoC 账号是否属于 Teams、能不能用 Admin API。

## 6. 模型

**事实**

- 选模型用 `--model <model>`。`agent models` 或 `--list-models` 列出**当前账号**可用的模型 [D-params]。文档没有给出一张完整的模型 slug 表。能看到的格式举例：`claude-opus-4-6`（Admin API 里的目录 id）、`claude-opus-5-5-fast`（models-and-pricing 页面）[D-admin][D-models]。
- 默认模型：2026-05-20 起新会话默认用 Composer 2.5 [CL]；v2026.07.06 起全新安装默认 Auto [CL]。在无头模式下应该总是显式传 `--model`。
- 相关修复 [CL]：
  - 2026-05-14：带 fast 或 high-effort 后缀的 slug 在 `-p` 模式下保留参数
  - v2026.08.11：无头模式下需要 Max Mode 的变体不再被降级
  - v2026.09.28：`--model` 严格执行指定的模型，以前 ID 前缀相同时可能悄悄换成基础模型
  - v2026.08.26：团队限制了模型时，传入被禁的 `--model` 会直接退出并给出限制信息
- 计费：Composer 2.5 和 Grok 4.x 计入每周额度池，第三方模型按 API 价格计费 [D-models]。
- Sandcastle 的 `init` 默认模型写的是 `composer-2` [SC `InitService.ts`]。它是 Composer 2.5 之前的那一代，现在还能不能用不清楚。

**未确认，需 M0 实测**：在容器里运行 `agent models`，确认 Composer 2.5 和备选模型的准确 slug，再写进项目配置。

## 7. 已知的卡死、限流和网络问题

已修复，可以作为锁定版本的下限参考 [CL]：

| 时间 | 问题 |
| --- | --- |
| 2025-09 | `-p` 运行完不退出（[论坛 133624](https://forum.cursor.com/t/cursor-cli-headless-mode-does-not-release-the-terminal/133624)，用户报告 `2025.09.18-7ae6800` 已解决） |
| 2026-02 | 以打开的 stdin 管道启动时 `-p` 会阻塞；网络故障切换从约 20 秒缩短到 8 秒 |
| 2026-03 | 断流和停滞默认自动重试；限流等服务端错误显示真实信息 |
| 2026-05-07 | 检测停滞的流并重试；HTTP/2 不正常时回退到 HTTP/1 |
| v2026.06.09 | HTTP/2 keepalive，几秒内发现静默停滞 |
| v2026.07.13 | DNS 或网络不可达时退避重试；自动更新清理不再删掉正在运行的版本 |
| v2026.08.11 | 长时间无头 HTTP/1.1 会话的上传卡住会被检测并重试；单轮运行会等子 agent 跑完再退出 |
| v2026.09.22 | 推理反复同一行时自动打断重试 |
| v2026.10.08 | 模型调用未知工具时不再挂起；上下文满了会先摘要再继续，不再卡住 |
| v2026.10.15 | 摘要相关的若干修复 |

和我们的环境有关的：

- Sandcastle 的 docker `exec` 在没有 stdin 时不加 `-i`，stdin 设成 `ignore` [SC `src/sandboxes/docker.ts`]，所以 2026-02 那个 stdin 管道阻塞的问题碰不到。
- 限流：changelog 只说会显示真实错误信息。限流时 CLI 是自己重试还是直接以非 0 退出，**未确认，需 M0 实测**。设计里"agent 卡死或跑飞"那条对策（`idleTimeoutSeconds` 加 `AbortSignal` 墙钟上限）仍然需要。
- 后台进程：无头运行会等后台 shell 和子 agent 结束再退出 [CL 2026-03、v2026.08.11]。如果 agent 在沙箱里启动了不会退出的 dev server，运行可能一直不结束，只能靠墙钟上限兜底。**未确认，需 M0 实测**。
- prompt 只能作为命令行参数传入。Sandcastle 限制在 120 KiB 以内，超过会直接报错 [SC `CURSOR_PRINT_PROMPT_MAX_BYTES`]，这一点设计里已经写了。
- 不能续接会话：`captureSessions: false`，也不传 `--resume` [SC]。注意 CLI 本身其实支持 `--resume [chatId]` [D-params]，限制来自 Sandcastle。

## 仍需 M0 实测的清单

1. 在 Sandcastle 的 docker 里只带 `--force` 运行，确认不会因为信任检查失败；如果失败，用包装脚本补上 `--trust`。
2. skills 挂载到 `~/.cursor/skills` 后，`-p` 模式能不能自动发现；按绝对路径读 SKILL.md 作为兜底是否可行。
3. cursor provider 下 `Output.object` 能不能取到结构化输出。
4. stream-json 里 usage 字段的名字和位置；`session_id` 和 Admin API 的 `conversationId` 是否一致。
5. 用 `agent models` 确认模型 slug，特别是 Composer 2.5 和 `composer-2` 是否还能用。
6. 容器里会不会自动更新、能不能关掉；没有 keychain 时凭据存储会不会报错。
7. 限流、断网时的退出码和行为；后台进程不退出时运行会不会一直挂着。
8. 默认 600 秒的空闲超时在长时间推理时会不会误杀（print 模式下没有思考输出）。
9. `attribution.attributeCommitsToAgent` 默认为 true 时，"Made with Cursor" trailer 和门禁里"补 trailer"的步骤会不会冲突。
