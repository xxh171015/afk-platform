# M1 平台：单仓库、无人值守的票流水线

2026-10-28 · 草稿，待用户确认后发布。依据：[design.md](../design.md)、[m1-tech-stack.md](../m1-tech-stack.md)、[GLOSSARY.md](../../GLOSSARY.md)，以及「AFK 研发平台：走到 M1 可交付实现」地图上各决策票的结论。术语以 GLOSSARY 为准。

## Problem Statement

开发者现在要靠自己一直盯着：每个需求走 grill → to-spec → to-tickets 拆成票之后，每张票都要手工开一个新的 agent 会话去实现，还要自己判断下一张能不能开工、门禁有没有过、哪张票卡住了。人必须一直在场，没有地方记录哪张票做到哪一步，出了问题也追不到是谁、在哪次运行里改的。

M0 已经证明单张票的链路可行（在 Mac 上，Sandcastle 加 Cursor Agent CLI，从实现到合并进集成分支，无人值守）；但那只是一个一次性的原型脚本，没有记录、没有调度、不能中断恢复、也没有人处理 blocked 的入口。

## Solution

做一个单机、单人使用的平台，把一个需求（Spec）的全部票自动跑到"可以由人验收"：

- 开发者在 Cursor 里规划需求，用 `plat` 把票和依赖边一次性导入平台，在页面上确认拆分。
- 之后无人值守：平台按依赖边算出能开工的票，把阶段作业排进队列；worker 以租约方式领作业，在一次性的槽位 clone 里起沙箱，跑 agent、门禁、review，把结果合进集成分支；全部票完成后做一次整体 review，用 GitHub App 开 PR，生成验收包。
- 任何一步中断、失败都有记录：票卡住时带原因码和简报进 blocked 队列，开发者在页面或用 `plat` 处理；worker 随时可以重启，不丢流程状态。
- 合并到 main 仍由人在 GitHub 上做。

范围只到单个仓库：不做前后端联调、不做多个需求并行、不做 PR 评论返工。

## User Stories

规划与导入

1. As a 开发者, I want 用 `plat project create` 和 `plat repo add` 登记项目和仓库，so that 平台知道我有哪些仓库、默认分支、保护路径和并发上限，不用另外做配置页面。
2. As a 开发者, I want 用 `plat spec create` 建一个需求并拿到 `S-12` 这样的编号, so that 后面所有票和运行都能追溯到它。
3. As a Cursor 里的 agent, I want 用 `plat tickets import S-12 tickets.yaml` 一次性导入整张依赖图, so that 不会出现只导进一半的票。
4. As a 开发者, I want 导入时平台校验依赖无环、仓库属于项目、每张票有验收标准和非空模块范围、contract 边的上游必须是契约票, so that 有问题的拆分在开工前就被拒绝。
5. As a 开发者, I want 同一仓库里模块范围重叠但没有依赖关系的票被告警, so that 我能决定加依赖还是放行。
6. As a 开发者, I want 在页面上看到依赖图和所有告警后点"确认拆分"（或 `plat spec confirm`）, so that 只有我确认过的拆分才会开始无人值守执行。
7. As a 开发者, I want 在票里写明哪些保护路径已批准可以改, so that 契约票这类合法的票不会被 agent 拒绝。
8. As a 开发者, I want 导入时 `external_blocked_by` 非空就被拒绝, so that 不会误以为 M1 支持跨需求的依赖。

调度与执行

9. As a 平台, I want 按依赖边实时算出哪些票可以开工（票是 pending、所有入边满足、没超并发和预算上限）, so that 不会出现"标了可开工其实还被挡着"。
10. As a 平台, I want 把每张票拆成独立、可重跑的阶段作业（implement、gate、review、merge 及三种 fix）, so that 任何一步中断后重跑都得到同样的结果。
11. As a worker, I want 以租约方式领作业、每 30 秒心跳续期, so that 电脑休眠后作业能被重新派发。
12. As a 平台, I want 只接受当前 attempt 的回传, so that 睡醒的旧进程不会覆盖新结果。
13. As a worker, I want 每个任务独占一个一次性槽位 clone, so that agent 弄坏的只是它自己的副本，不会碰到主 clone。
14. As a 平台, I want 同一集成分支上的合并类作业互斥且先进先出, so that 两个 worker 不会同时白跑同一个候选门禁。
15. As a 平台, I want 每个阶段由 API 决定下一步（worker 只交回事实）, so that worker 重启或换机器不丢流程状态。
16. As a 开发者, I want 单个 agent 运行有空闲超时、墙钟上限，每张票有总时长和 fix 次数上限, so that 跑飞的 agent 不会无限烧额度。
17. As a 平台, I want 到 spec 的总时长上限时自动暂停并进 blocked 队列, so that 成本有上限。

门禁与安全

18. As a 平台, I want 门禁配置取自基准提交而不是 agent 分支, so that agent 改了配置也不影响结果。
19. As a 平台, I want 门禁在全新沙箱里跑, so that agent 在容器里留下的东西影响不到门禁。
20. As a 平台, I want 测试总数不能变少、跳过数不能变多, so that "悄悄跳过测试"会被发现。
21. As a 平台, I want 碰到未批准的保护路径就让票进 blocked（`protected-path-changed`）, so that 配置和契约不会被悄悄改掉。
22. As a 平台, I want 结构化输出不合法就判 `invalid-output`, so that 不信任 agent 的自我报告。
23. As a 平台, I want 候选合并提交通过门禁才前移集成分支, so that 单张票各自绿、合起来红的情况进不了集成分支。
24. As a 平台, I want 所有推送都走同一个函数且只放行 `agent/*` 和 `spec/*`, so that 平台自己永远不会往 main 推送或合并 PR。
25. As a 开发者, I want 每个仓库有一个检测用的工作流，发现 `main` 上出现没有对应已合并 PR 的提交就开 issue, so that 万一平台出错我能事后发现。
26. As a 平台, I want 沙箱里只有 Cursor API key 一个密钥, so that git 和 GitHub 凭据永远不进沙箱。

处理 blocked

27. As a 开发者, I want 票进 blocked 时带原因码和简报（失败步骤、日志指针、agent 的结构化输出）, so that 我不用翻原始输出。
28. As a 开发者, I want 在页面或用 `plat` 选择"接着重试 / 从头重试 / 批准保护路径改动 / 取消", so that 我处理一张 blocked 票只需要一个动作。
29. As a 开发者, I want 取消一张票时选择下游票是进 blocked 还是一并取消, so that 我控制影响范围。
30. As a 开发者, I want `plat blocked` 列出所有待处理的 blocked 票、paused 的需求，以及在代码托管上关闭但没合并（或平台读不出状态）的 PR, so that 我一眼知道有什么要我处理。

可见性与追溯

31. As a 开发者, I want 页面上看到需求列表、每个需求的依赖图（节点按票状态着色）, so that 一眼知道进度。
32. As a 开发者, I want 看到每张票的每次运行、日志、GateResult 和 Finding, so that 我能复盘一次运行里发生了什么。
33. As a 开发者, I want 日志几秒内刷新到页面上, so that 我能看着 agent 在做什么。
34. As a 开发者, I want 在页面顶部搜索需求和票的编号、标题、正文, so that 找历史记录不用翻列表。
35. As a 开发者, I want 每个 agent 的 commit 都带 `Spec`、`Ticket`、`Run` trailer, so that 从任意一行代码都能追溯到原需求。
36. As a 开发者, I want 契约票完成后平台记下契约 SHA, so that 下游票只用这个 SHA 上的契约。

收尾

37. As a 平台, I want 全部票完成后对集成分支做一次整体 review 和一次修复, so that 合起来的整体也被审查过。
38. As a 平台, I want 用 GitHub App 开 PR 并轮询状态（CI、review、是否已合并）, so that 我在页面上看到 PR 的进展。
39. As a 开发者, I want 一份验收包（每条验收标准对应哪个测试及是否被 JUnit 核验、review 意见及处理结果、agent 标出的不确定点、门禁和 CI 结果、耗时、被批准过的保护路径改动）, so that 我看完就能决定合不合。
40. As a 开发者, I want PR 合并后需求自动进入 merged 状态, so that 记录和代码托管一致。

可恢复性

41. As a 开发者, I want 任何阶段中断（worker 被杀、电脑休眠）后系统自动恢复且结果一致, so that 我不用手工收拾现场。
42. As a 开发者, I want 回收僵尸槽位时先取回已有的 commits、再存未提交改动的 diff, so that 已完成的工作不丢。

## Implementation Decisions

### 模块与依赖方向

pnpm workspace 六个包，依赖方向 `shared ← api`、`shared ← pipeline ← worker`、`shared ← cli`、`shared ← web`：

- **shared**：zod schema、实体类型、状态机纯函数、生成的 API 客户端。所有状态流转逻辑在这里。
- **api**：Hono 服务、调度器、作业队列、Drizzle 表结构与迁移、worker 专用接口、日志存储、GitHub 适配器（开 PR、轮询）。
- **pipeline**：各阶段函数（M0 原型整理而来）；**唯一调用 Sandcastle 的模块**，以后 patch 或 fork 只动这里。
- **worker**：租约循环，向 API 领作业，调用 `pipeline` 执行**一个阶段**，把事实交回 API。
- **cli**：`plat`。
- **web**：页面。

`worker` 不引用 `api`、不连数据库，只通过 HTTP 和 API 说话（M3 搬到服务器时不用改）。依赖方向靠 pnpm 严格依赖保证。技术选型见 [m1-tech-stack.md](../m1-tech-stack.md)。

### 谁决定下一步

worker 是无状态执行器：领一个作业，执行一个阶段，交回事实（退出码、commits、结构化输出、GateResult、日志）。**API 决定下一步**：收到结果后调用 `shared` 里的状态机纯函数，更新 Ticket / Spec 状态，再入队下一个阶段的作业。fix 次数上限、blocked 原因码、重试语义都在状态机里。

### 数据模型

设计里的 9 个实体：Project、Repo、Spec、Ticket、Edge、Run、Finding、Job、GateResult，字段以 [design.md「领域模型与状态机」](../design.md#领域模型与状态机)为准，以下为 M1 的补充：

- 库里用普通自增主键，显示编号由前缀加序号生成（`S-12`、`T-123`、`R-456`）。
- Job 增加可空的互斥键 `lock_key`。
- Run 记录 `duration_ms` 和 `duration_api_ms`（取自 Cursor 的 `result` 事件）、运行次数；token 用量字段留空。
- Run 记录使用的 skills 仓库 commit SHA、Cursor CLI 版本、模型。
- Ticket 的"已批准的保护路径"来自导入时的 `protected_paths_ok`，渲染 `/context/run.json` 时写成 `allowedProtectedPaths`。
- 迁移文件提交进仓库，显式执行迁移，API 启动时发现有未执行的迁移就拒绝启动。不做 SQL 种子，演示数据走 `plat` 命令。

### 状态机

Spec 和 Ticket 的状态机照 design.md：Spec 的 draft → planned → running → finalizing → awaiting-review → merged，外加 paused、cancelled；Ticket 的 pending → queued → running → merging → done，外加 blocked、cancelled。"能不能开工"实时计算，不存成状态。M1 不用的状态（partially-merged、reworking）建枚举但不实现流转。

### 作业队列

自己在 Postgres 表上实现，放在 `api` 里的一个模块。语义：

- **领取**：`FOR UPDATE SKIP LOCKED`，2 分钟租约，30 秒心跳续期；租约过期回到队列，attempt 加一。
- **fencing**：API 只接受当前 attempt 的回传和 `pre-push`。
- **幂等键**：`(票, 内容版本, 阶段, 序号)` 唯一约束；重复提交返回已有结果。
- **能力标签**：作业声明需要的能力（docker、能访问哪些仓库），worker 只领自己能做的。
- **互斥键**：带 `lock_key` 的作业，领取时排除"同键已有未过期租约"的作业；持有期等于租约期；同键先进先出，不设优先级。键格式 `integration:<仓库>:<spec/slug>`。带键：`merge` 阶段、`finalize` 里改集成分支的部分。不带键：agent 运行、`open-pr`、`host-sync`。（M1 不做 `update-branch`、`rework`。）
- 备选 pg-boss（≥ 12.35）写进文档，不实现。

### 阶段与流水线

阶段：`prepare / implement / gate / review / merge / gate-fix / review-fix / merge-fix / final-review / final-fix`，另有作业类型 `open-pr`、`host-sync`、`spec-cleanup`（spec 取消或 merged 后关 PR、删 `spec/*` 和 `agent/*` 分支）。流程照 [design.md「单票执行流水线」](../design.md#单票执行流水线)：implement → 补 trailer 并推送 → 保护路径检查 → 门禁 → review（只跑一次）→ `merge`（merge-tree 候选 → 候选门禁 → 带 lease 前移集成分支）。每种 fix 每张票最多一次，一张票最多 5 次 agent 运行。

- `merge` 是独立的阶段作业，带 `lock_key`。冲突或候选门禁失败时它结束、锁随租约释放，merge-fix 作为不带键的 agent 作业去跑，再排一个新的 `merge` 作业。
- 推送集成分支前先调 `pre-push`（校验仍是当前持有者并续期），推送用 `--force-with-lease`，另有"agent 分支 head 已是集成分支祖先就当作已合并"的幂等检查。
- 补 trailer 用 plumbing 逐个重写本次新增的 commits（同一棵树、同一作者、parent 映射到新 commit，不 rebase、不需要 worktree），所以 merge-fix 产生的 merge commit 和里面的冲突解决原样保留，从集成分支并进来的 commits 不动；Cursor 自带的 `Co-authored-by` trailer 保留，追溯只认 `Spec` / `Ticket` / `Run`。
- review 只审查不改代码；它的 `suggestions` 记成 Finding（处理结果"进验收包"）。
- 收尾 `finalize`：全部票 done 后对集成分支跑一次整体 review 和一次修复（`final-review`、`final-fix`，各一次），修复后过门禁，然后 `open-pr`。

### 槽位与 Sandcastle 的使用

照 [design.md「Git 操作规范」](../design.md#git-操作规范)：槽位数等于 worker 并发上限；每个任务 `git clone --no-hardlinks` 主 clone 到 `~/.afk/slots/<n>/<repo>`，用 Sandcastle 的 `cwd` 选项指向它；成功即删，失败保留到下次占用；`O_EXCL` 槽位锁；取回结果只 `fetch` 回 `agent/<ticket-id>` 一个 ref 并开 `transfer.fsckObjects`；回收僵尸槽位按"取回 commits → 存 diff → 重建"。连续性的单位是分支，不是 worktree。

Sandcastle 固定 `0.12.0`。agent 运行用顶层 `run()` + `Output.object`（zod 校验，`<result>` 标签）；门禁另起新沙箱用 `sandbox.exec`，命令用 `timeout` 包住。沙箱里只有 `CURSOR_API_KEY`，通过 `cursor(model, { env })` 传入；`/context` 和 skills 只读挂载，skills 挂 `/home/agent/.cursor/skills`（[mattpocock/skills](https://github.com/mattpocock/skills) 固定 `59db609eb1e18aaf59b63284d0e52255aff0c63c` 的 `skills/engineering`）。

### 门禁

照 [design.md「门禁」](../design.md#门禁)：配置取自基准提交；全新沙箱；命令按顺序跑、第一个失败就停；失败日志最后 200 行写进 `/context/failure/gate.log`；测试总数/跳过数只在拿到 JUnit 时比较；`GateResult` 按 commit SHA 存并缓存，基线门禁复用。保护路径检查"碰到的减去已批准的"，非空才 `protected-path-changed`。

### 渲染 /context 与 AFK prompt

照 [design.md「Agent 与 skills 对接」](../design.md#agent-与-skills-对接)：worker 向 API 取 bundle（票、需求、已批准的保护路径、契约内容）渲染 `/context`。prompt 只放指针；implement、fix（靠 `run.json` 的 `stage` 区分三种 fix）、review 三份初稿已在原型分支 `prototype/m0-pipeline`，M1 直接用。`cannot-proceed` 必须带枚举 `blockedReason`（`agent-gave-up` / `contract-change-needed`）和 `detail`。

### worker 专用接口

都带 `(作业号, attempt)`，API 只认当前 attempt：

- `POST /worker/jobs/claim`：带能力标签，返回作业、attempt、租约到期时间和 `lock_key`。
- `GET /worker/jobs/:id/lease?attempt=`：只读，这个 attempt 是否仍持有有效租约；worker 判断槽位锁是不是僵尸时用，不续期。
- `POST /worker/jobs/:id/heartbeat`：续期。
- `POST /worker/jobs/:id/pre-push`：推送前校验并续期。
- `POST /worker/jobs/:id/complete`、`/fail`：交回阶段结果。
- `GET /worker/jobs/:id/bundle`：渲染 `/context` 所需数据。
- `POST /worker/runs/:id/logs`：分块追加日志。**日志由 API 存**（M1 是 API 管理的本地目录，M3 换 MinIO），页面通过 API 读。

### 推送出口与检测

- worker 里所有 `git push` 走同一个函数，只放行 `refs/heads/agent/*` 和 `refs/heads/spec/*`；平台代码里不调用任何合并 PR 的接口。
- 每个仓库一个检测用的 Actions 工作流，监听 `push` 到 `main`，用 commits → pulls 接口查这次提交有没有对应的已合并 PR；没有或推送者是 bot，就失败并开 issue。只做事后检测。
- GitHub App 权限：Contents 读写、Pull requests 读写、Checks 只读、Commit statuses 只读，**不给** Workflows、Administration、Actions 写、Issues、Secrets；不订阅 webhook，轮询（每分钟）同步。凭据在 `~/.afk/secrets/github-app/`（`private-key.pem`，权限 600；`app.json`：`{"appId":"…","installationId":"…"}`），worker 换 installation token 时限定本次任务的仓库和权限，缓存到过期前 5 分钟；推送用 `http.extraHeader`。

### plat CLI

命令（都支持 `--json`）：`project create`、`project edit`、`repo add`、`spec create`、`tickets import`、`spec confirm`、`spec show`、`spec cancel`、`spec cleanup`、`ticket view`、`ticket retry --mode continue|restart`、`ticket approve-protected`、`ticket allow-path`、`ticket cancel [--cascade]`、`blocked`、`run logs <run>`。不做 `ticket edit`、`context`、拆票。导入格式照 design.md 的 `tickets.yaml`；校验四条加模块重叠告警；`external_blocked_by` 必须为空。`contract` 边和契约 SHA 在同仓库内实现。

### 页面

四个视图，以读为主，加一个全局搜索框：

- 需求列表（状态、进度）。
- 需求详情：依赖图（`@xyflow/react`，节点按票状态着色）、导入告警、"确认拆分"按钮。
- 票详情：运行列表、日志（轮询刷新）、GateResult、Finding。
- blocked 队列：原因码、简报、动作（接着重试、从头重试、批准保护路径、取消）。
- 搜索：需求和票的编号、标题、正文，不分大小写子串匹配（`ILIKE`），结果按需求和票分组，不引入搜索引擎。

不做：编辑票、拖拽改依赖、通知、权限。

### 并发与预算默认值（都放项目配置，可改）

每台 worker 2 个槽位；每个项目、每个仓库各最多 2 个并发 agent 运行；单次运行空闲超时 600 秒、墙钟 60 分钟；每张票最多 5 次 agent 运行、总墙钟 3 小时；每个 spec 的 agent 总时长 12 小时；到上限时 spec 自动 paused 并进 blocked 队列。

### 沙箱镜像

在试点仓库的镜像基础上装 PostgreSQL（沙箱里没有 Docker，门禁要跑真数据库测试）；门禁的 `setup` 在一次性目录里起临时实例。Cursor CLI 版本锁定。

## Testing Decisions

好的测试只测外部行为，不测实现细节。三层，尽量用最高的一层：

1. **API 层**：通过 HTTP 加真 Postgres（不 mock）测行为；状态机用纯函数的表格测试。这一层覆盖：导入校验、调度（谁可开工）、租约/fencing/幂等/`lock_key` 互斥、blocked 的各动作、finalize 触发。
2. **pipeline 层**：在临时 git 仓库里测各阶段函数；用一个假的 agent 运行器（会提交文件的脚本）代替 Sandcastle 那个模块，这个模块就是缝。覆盖：补 trailer、保护路径检查、门禁比较（含总数/跳过数）、`merge-tree` 候选（含冲突）、取回只收一个 ref、槽位回收。
3. **端到端（不进自动化）**：真 Cursor、真 Docker，只做验收需求和中断演练。

先例：M0 原型分支 `prototype/m0-pipeline` 里的纯 git 部分已在本机用造出来的 commit 验证过，可以改写成第 2 层的测试。

## Out of Scope

- 前端仓库、跨仓库需求、契约先行拆票、联调（M2）。
- `update-branch`、`trial-merge`、多个需求同时跑、跨需求的依赖边（M3）。
- PR 评论返工 `rework`、bug 类型 spec、`plat context`、追溯反查（M4）。
- 事件与插件、信任阶梯、权限与登录（M5）。
- GitLab 适配器、多 worker、MinIO、公司服务器部署（M3）。
- 编辑票、拆票动作、页面上编辑依赖、通知。
- 向量检索、搜索引擎。
- 批量合并（等 M1 跑出真实的门禁耗时和合并频率再看）。
- 容器加固（去 capability、限进程数和内存）：PoC 不做，列入上服务器前检查项。
- GitHub 真强制"由人合并"（免费账号用不了 ruleset）：用推送出口 + 检测工作流 + App 不给 Workflows 权限，缺口已知。

## Further Notes

### 建议的实现顺序（供 to-tickets 参考）

0. **人工前置**：建 GitHub App（下面有清单）。
1. 脚手架：monorepo、compose（只放 Postgres）、沙箱镜像（装 PostgreSQL）、门禁 `setup`、把 M0 原型整理进 `pipeline`。
2. `shared`：zod schema、状态机纯函数及表格测试。
3. 建表迁移 + 作业队列（租约、fencing、幂等键、`lock_key`）+ 自动化测试。
4. 调度器 + API + worker 专用接口。
5. `plat` CLI。
6. worker 租约循环 + 阶段执行，接上槽位。
7. `merge` 阶段、推送出口函数、检测工作流。
8. finalize、开 PR、轮询状态、验收包。
9. 页面（含搜索）。
10. 中断演练和验收需求。

每一步都应能独立验证；具体拆成几张票由 to-tickets 定。第 3 步之后的票要用真数据库，所以第 1 步的镜像和 `setup` 必须先完成。

### 前置：建 GitHub App 的清单（只有人能做）

1. GitHub → Settings → Developer settings → GitHub Apps → New：名称自拟，Webhook 关闭（取消勾选 Active）。
2. Repository permissions：Contents 读写、Pull requests 读写、Checks 只读、Commit statuses 只读，Metadata 只读（自动）；其余全部 No access。
3. 创建后记下 App ID，生成一个私钥（下载 `.pem`），放进 `~/.afk/secrets/github-app/`，权限 600。
4. Install App → 只勾选 `afk-pilot-backend`，记下安装 ID。
5. 在 M1 第一周用它验证三件事（见下）。

### M1 第一周要验证的假设

- 没有 `workflows` 权限的 App 推不了对 `.github/workflows/` 的改动。
- App 开的 PR，本人可以直接合并（免费版没有 approve 要求）。
- 检测工作流能区分"经 PR 合并"和"直接推送"。
- 槽位方案：用 Sandcastle 的 `cwd` 指向槽位 clone 能跑通 agent 运行和门禁；`--no-hardlinks` 克隆耗时可接受；`git fetch` 只取回一个 ref 并开 `transfer.fsckObjects`。

### 验收需求

在试点仓库上跑一个 5 张票的需求（"订单备注"），见 [m1-acceptance/](m1-acceptance/)：

1. 契约票：补 `note` 字段和 `PATCH /orders/:id` 的契约，批准保护路径 `openapi/openapi.yaml`（覆盖已批准的保护路径、契约 SHA）。
2. 加 `note` 字段（模型、存储、校验）。
3. `PATCH /orders/:id` 改备注（依赖 1 和 2）。
4. 按客户过滤订单列表（和 2、3 都改 `src/orders/`，覆盖模块重叠告警、并行）。
5. 统计里加按状态分组（依赖 2）。

**通过标准**：5 张票从导入到 PR 开出，人只在确认拆分和最后合并时出现；全程每次运行可追溯（Run、日志、GateResult、trailer）；至少一次 fix 或 blocked 被自然触发后处理成功也算通过，只要可追溯；验收包生成。

### 中断演练清单（手动，由人在 Mac 上用真实 pipeline 和真实 Cursor 跑）

对照预期结果打勾：

- [x] 在 implement 运行中杀掉 worker（2026-10-29，#47：agent 提交后 SIGKILL，重启后自动移除孤儿沙箱、取回 commit、重派发，票只合并一次）：租约过期后作业被重新派发；槽位被回收（先取回已有 commits，再存 diff，再重建）；这一阶段从头跑；最终结果与不中断一致。
- [x] 在门禁运行中杀掉 worker（2026-10-29，#42：S-6/T-10，门禁作业 attempt 2 重跑并通过）：作业重派，重跑门禁，结果一致。
- [x] 在 `merge` 阶段（候选门禁中）杀掉 worker（2026-10-29，#42：S-7/T-11，杀后集成分支仍在出发点，重启后才前移到完整的合并提交）：锁随租约释放；新作业接手；集成分支没有被前移到半成品。
- [x] 旧 worker 睡醒后继续推送（2026-10-29，#47：冻结后被另一个 worker 接手，醒来时心跳发现租约已失，放弃运行，没有推送；票只合并一次）：旧 attempt 的 `pre-push` 被拒绝；即使它推送成功，新持有者的幂等检查也把它当作已合并，不重复合并。
- [x] 同一个 `lock_key` 上两个 `merge` 作业（2026-10-29，#42：S-8/T-12、T-13，第一个 done 时第二个才 running，没有重叠）：第二个在第一个结束前不会被领取。

### 并发与预算

见"并发与预算默认值"。到上限时 spec 自动 paused 并进 blocked 队列。

### 已知的、没有实测过的

merge-fix、`timeout`、`invalid-output`、`no-commits` 这几条 blocked 路径，以及中断后的恢复，在 M0 里没有触发过，要靠 M1 的自动化测试和上面的演练清单覆盖。保护路径的兜底检查只在本机用造出来的 commit 验证过。
