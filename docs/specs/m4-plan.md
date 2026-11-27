# M4（Mac 本机版）：飞书通知、容器加固、追溯与 bug 自动定位

## Context

M3 已完成，平台在用户 Mac 本机跑通（控制面 + worker 都在 Mac）。M4 原定内容见 `docs/design.md:340-341`、`docs/specs/m3-platform.md:193-199`。
用户 2026-11-11 定：M4 继续只在 Mac 本机跑通全流程，**不做**：迁公司服务器、多 worker（能力标签 / 协议版本 / `plat drain`）和登录、沙箱出网白名单。

本次三块（用户已选定）：
1. **飞书通知**：企业自建应用机器人（应用已有，可直接实测），**按项目发到群**（项目配 chat_id）；通知、SSE、时间线改读事件表（#206，调研 #199）。macOS 通知保留。
2. **容器加固**（从 #209 拆出，不含白名单，调研 #200）。
3. **追溯 + bug 自动定位**：Link 表、`plat context --files`、bug 类型需求指向原需求，外加平台只读诊断阶段：给报错/堆栈，agent 定位到文件后自动建 bug 需求草稿。

流程（用户定）：**这次只提交本计划文件，不写代码、不展开成完整 spec、不开 issue**；实现由用户在 Mac 上做。
提交步骤：从 `main` 开分支 `docs/m4-plan`，把本文件原样放到 `docs/specs/m4-plan.md`，提交、推送、开 PR。

## 现状（探查结论）

- **通知**：`packages/api/src/notify/channel.ts:9` `NotificationChannel { notify(notice) }`，`Notice = {title, body}`；只有 silent 和 macOS（`server.ts:38` 写死）。触发靠 `events/announce.ts` 的前后快照对比（`noticesFromTransition`，`notices.ts:127`，7 种），不读事件表；另有磁盘、agent 暂停、PAT 到期三处各自去重的通知。
- **事件表**：`db/schema.ts:647`，DB 触发器同事务写入（`drizzle/0035_events.sql`，ADR 0008），来源经 `events/origin.ts`；人的操作 `events/human-actions.ts`。只给度量、工期、待处理、时间线两处细节读。
- **SSE**：`http/event-routes.ts` + 进程内 `EventsHub`，由 `emitTransition` 发布，不读库。
- **时间线**：`tickets/timeline.ts:49` 从领域表拼 14 种条目，只从事件表取两处细节。
- **没有用户/收件人概念**；页面链接用 `page-url.ts`（`AFK_PAGE_URL`）。API 目前不读任何密钥；密钥模式见 `host/src/gitlab-token.ts`（600、每次重读）。
- **沙箱**：全部 Sandcastle 调用在 `packages/pipeline/src/sandcastle.ts`（有单入口守卫测试和 0.12.0 版本锁）；`provider()` 用内置 `docker()`，无法加 cap-drop/内存等参数；`createBindMountSandboxProvider` 需自己实现 `exec`（逐行流）、`copyFileIn/Out`、`close`。退出状态从不看，OOM 无信号。镜像 `ENTRYPOINT sleep infinity`，Postgres 走 `scripts/pg-temp.sh`（非 root），Chromium `--no-sandbox`。
- **追溯**：`pipeline/src/trailers.ts:36` 给每个提交打 `Spec/Ticket/Run` trailer，`runs.commits` 已存改写后的 SHA；集成分支是真合并提交，trailer 保留。无 Link 表、无 `plat context`；`specs.source_spec_id`、`type=bug` 已在 schema 里但从没读写（`planning.ts:190/228` 不写）。适配器 `PullRequestInfo`（`host/src/types.ts:30`）没有合并提交 SHA。联调诊断阶段（`prompts/afk-integration.md`、`stages/results.ts:139`、`stages/integration.ts`）是"只读 agent → 结构化定位 → 自动建票"的可复用模式。

## 要做的事

### 第一步：写 spec 和设计文档（一个 PR）

- 新建 `docs/specs/m4-platform.md`，章节照 M3：Problem Statement / Solution / User Stories / Implementation Decisions / Testing Decisions / Out of Scope / Further Notes（实现顺序、前置、验收需求、演练清单、未实测项）。
- 同 PR 改 `docs/design.md`（M4 落地路线和架构图：去掉本次不做的、标出挪到 M5/以后的）、`GLOSSARY.md`（Link、追溯、bug 需求、定位阶段等新词）；必要时一条 ADR（通知从事件表出发、按事件 id 去重）。
- 合并后在 GitHub 开父票（照 #214：正文是 spec 全文 + 源文件链接）和实现票（sub-issue，`ready-for-agent`，native blocked-by），演练、验收票 `ready-for-human`。更新记忆 `project-platform-direction`（M4 范围）。

### spec 里要写定的实现决策

**A. 事件驱动的通知和 SSE**
- `afk_record_event` 触发器里加 `pg_notify('afk_events', id)`（提交后才送达）；API 起一个 LISTEN 连接，按游标读新事件，断线后按游标补读。
- SSE：`EventsHub` 改由事件流喂，`InvalidatePayload` 从事件的 spec/ticket/run 推出；去掉各路由里的手动 publish（`emitTransition` 退役）。
- 通知派发器：事件 → 现有 7 种通知（复用 `composeNotice` 文案），游标持久化在 `instance`（`last_notified_event_id`），同一需求 30 秒内的多条合成一条，重启不重发。磁盘、agent 暂停、PAT 到期三类改为写系统事件（`type` 新增 `system`）走同一派发器（PAT 到期顺带修掉事务内发通知的问题）。
- 渠道：`NotificationChannel` 改为接收 `{notice, projectId?, eventId}`；macOS 渠道保留；`server.ts` 按配置组装多渠道。

**B. 飞书渠道**
- 应用凭据放 `~/.afk/secrets/feishu/app.json`（600，`app_id`/`app_secret`），API 每次发送前按需取 `tenant_access_token` 并缓存到过期前；文件缺失则渠道关闭，页面状态区提示。
- 发送 `POST /open-apis/im/v1/messages?receive_id_type=chat_id`，消息卡片（标题、需求/票、原因、按钮 `open_url` 到页面，标注"本机链接"），`uuid` 用合并后首条事件 id 防重发；限频按 5 QPS 排队，失败退避重试 3 次后记日志，不阻塞派发。
- 项目设置加 `feishu_chat_id`（项目设置页 + `plat project set --feishu-chat`）；平台级默认群（`AFK_FEISHU_DEFAULT_CHAT`）收没有项目的系统通知和没配群的项目；"测试发送"按钮/命令。

**C. 时间线读事件表**
- 有事件的需求，时间线的状态变化和人的操作从事件表出（`specTimeline` 改读事件，保留 PR、验收包等领域条目）；事件表上线前的老需求保持现有拼法，页面注明。web 端 `spec-timeline.ts` 的种类表同步。

**D. 容器加固**
- 在 `sandcastle.ts` 内用 `createBindMountSandboxProvider` 写自有 docker provider（不 fork），`docker run` 加：`--cap-drop ALL`、`--security-opt no-new-privileges`、`--init`、`--pids-limit`、`--memory`（同值 `--memory-swap`）、`--cpus`、`--shm-size`、`--label afk.run=<R-n> afk.kind=agent|gate`；保持现有 mounts、env、network、`--user`、`HOME`。默认值（可用 worker 环境变量改）：内存 3g、pids 4096、cpus 2、shm 1g——按 Mac VM 7.8 GiB 定，spec 写明依据，原型阶段实测后调。
- 自写 `exec` 逐行流（idle 超时依赖它）、`copyFileIn/Out`（`docker cp`）、`close`（stop + rm）；docker CLI 做成可注入函数（照 `worker/src/sandboxes.ts` 的 `Docker` 缝）。
- OOM：`exec` 非零退出或 `close` 前 `docker inspect` 读 `State.OOMKilled`，新原因码 `sandbox-oom`（失败来源 = 平台，提示调大内存），`shared/src/failure-source.ts` + DB check 约束 + 页面文案。
- 残留清理改用 label 过滤（`removeSandboxesUnder` 保留挂载路径兜底）。联调 compose 服务不加固，只加固沙箱容器。

**E. Link 表与 `plat context --files`**
- 新表 `links(repo_id, commit_sha, spec_id, ticket_id, run_id, pull_request_id, kind)`；来源两处：合并进集成分支时从 `runs.commits` 写（票↔提交）；host-sync 首次看到 PR 已合并时，适配器返回 `merge_commit_sha`/`squash_commit_sha`（GitHub、GitLab 都加），排一个 worker 作业读 main 上该合并带进来的提交，正则读 trailer 写 link（squash 时只能到需求级，以 PR 正文的 `Spec:` 为准）。
- `plat context --files a.ts b.ts [--repo]`：CLI 在本机 checkout 里 `git blame --porcelain` 取 SHA，读这些提交的 trailer（共享解析器放 `@afk/shared`），调 `POST /trace/context`（新 `http/trace-routes.ts`），API 用 links 补全，返回每个文件涉及的需求、票、PR/MR 链接、需求里的实现决策和不做的范围、相关 ADR——全是指针，不复制内容；`--json` 机器输出。

**F. bug 需求与自动定位**
- `plat spec create --type bug --source S-n`；`NewSpec`/`createSpec` 写 `source_spec_id`；需求详情页显示"原需求"并在原需求页列出它的 bug；页面加追溯视图（文件 → 提交 → 票 → 需求 → PR）。
- `plat bug --project <p> --file report.md`（报错、堆栈、现象）：建一个"定位"作业，新阶段 `locate-bug`，只读 agent 在各仓库默认分支的槽位里运行（新提示词 `prompts/afk-locate-bug.md`，复用 diagnosing-bugs 的方法），输出 `{result, repo, files[], evidence, reproduction}`；worker 在同一槽位跑 blame + trailer 解析得到原票、原需求。
- 结果：定位成功 → 自动建 `type=bug` 的需求草稿，`source_spec_id` 指原需求，正文预填报告、证据、指针（`plat context` 的结果）；定位不了 → 只出诊断报告，进待处理（新原因码 `bug-unlocated`，来源 = 需求本身）。之后由人照常规划（grill → to-tickets → confirm），走同一条流水线。不自动拆票、不自动开工。
- 通知：bug 定位完成/失败走 A+B 的通知。

### Out of Scope（写进 spec）
迁服务器、多 worker、登录与凭证、出网白名单、GitLab bot 账号与 PAT 自动轮换、webhook、飞书卡片按钮直接操作（长连接）、按人发私信、GLOSSARY/ADR/契约的 pgvector 索引、接线上监控、自动拆 bug 票。

## 建议的实现票顺序（spec「Further Notes」里给出，to-tickets 时细化）

1. 事件推送：触发器 `pg_notify` + API 监听 + 游标；SSE 改由事件喂。
2. 通知派发器从事件出发（合并、去重、系统事件），macOS 渠道接上。←1
3. 飞书渠道 + 项目群设置 + 默认群 + 测试发送。←2
4. 时间线读事件表。←1
5. 加固 provider（可注入 docker、label 清理）。
6. `sandbox-oom` 原因码与 OOM 检测。←5
7. Link 表：集成合并写 link；适配器返回合并 SHA；合并后读 trailer 作业。
8. `plat context --files` + `/trace/context`。←7
9. bug 需求：`--source`、原需求关联、追溯视图。←8
10. `locate-bug` 阶段与 `plat bug`，自动建 bug 需求草稿。←8、9
11. 演练（ready-for-human）。12. 验收（ready-for-human）。

1、5、7 可并行起步。

## 关键文件

- 通知/事件：`packages/api/src/notify/{channel,notices}.ts`、`events/{announce,hub,origin}.ts`、`http/event-routes.ts`、`server.ts`、`disk.ts`、`agents-pause.ts`、`host/code-hosts.ts`、`drizzle/0035_events.sql`（新迁移改触发器）
- 时间线：`api/src/tickets/timeline.ts`、`web/src/spec-timeline.ts`
- 沙箱：`packages/pipeline/src/sandcastle.ts`（+ `.test.ts` 守卫）、`worker/src/{sandboxes,config,main}.ts`、`shared/src/failure-source.ts`、`api/src/db/schema.ts`
- 追溯：`pipeline/src/trailers.ts`、`worker/src/{executor,host}.ts`、`host/src/{types,github,gitlab}.ts`、`api/src/host/pull-requests.ts`、`api/src/planning/planning.ts`、`api/src/stages/{results,integration}.ts`（定位阶段照抄模式）、`cli/src/index.ts`、新 `api/src/http/trace-routes.ts`、`pipeline/prompts/`

## 验证

- **自动测试**（照 M3 三层）：API 层（真 Postgres）——事件 → 通知映射、30 秒合并、游标重启不重发、系统事件、SSE 由事件喂、时间线条目、Link 写入、`/trace/context` 解析、bug 需求 `source_spec_id`、定位结果建草稿/进待处理；pipeline/worker 层——加固 provider 的 `docker run` 参数（假 docker）、OOMKilled 映射、trailer 解析和 blame、适配器合并 SHA（假 GitLab/GitHub HTTP）、飞书客户端（假飞书 HTTP：取 token、缓存、限频、重试、uuid）。门禁按 `AGENTS.md`。
- **Mac 实测**（`ssh mac`，独立端口/库/`AFK_HOME` 的原型 + 最后在 3000 平台演练）：
  - 加固下跑试点前后端门禁（Postgres、Chromium e2e）和一次真实 Cursor implement；用一个超内存的命令触发 OOM，看到 `sandbox-oom`。
  - 飞书：项目配真实群 chat_id，制造 blocked、需求完成，群里收到合并后的卡片，重启 API 不重发。
  - 追溯与 bug：在 shop-gl（M3 订单备注需求已合并）上造一个订单备注相关的 bug 报告，`plat bug` → 定位到后端文件 → 自动建 bug 需求，指向订单备注需求；`plat context --files` 在本机 checkout 里给出同样的指针。
