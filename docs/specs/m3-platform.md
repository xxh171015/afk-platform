# M3 平台：GitLab、多需求并行、基础度量，先在 Mac 本机用起来

2026-11-09 · 草稿，待用户确认后发布。2026-11-09 修订：M3 先用用户的个人 GitLab 令牌，bot 账号放到 M4（见「GitLab 令牌」）；前置步骤已做完。依据：[design.md](../design.md)、[m2-platform.md](m2-platform.md)、[GLOSSARY.md](../../GLOSSARY.md)，以及「AFK 研发平台：走到 M3 可交付实现」地图（#196）上各决策票的结论。术语以 GLOSSARY 为准。

## Problem Statement

M2 在 GitHub 上把一个前后端需求跑到了「人只在首尾出现」，但离团队日常使用还差几步：

- 公司的代码在 GitLab CE 17.3.1 上，平台只会推 GitHub、开 PR。
- 两个需求可以同时开工（#195 已修好名额），但集成分支不跟着 main 走：先合的需求进了 main，后合的那个就过时或冲突，到人验收时才发现；两个需求改到同一个文件，平台也不提醒。
- 平台不记状态什么时候变的，只能拿 Run 的起止时间手算：一个需求的工期花在 agent、门禁、排队还是等人身上，平台自己出了几次故障，都说不清。
- 日志、沙箱原始日志从不清理；用户的 Mac 只剩 23 GiB，平台不会提醒，磁盘满了只会莫名失败。

## Solution

M3 先在用户的 Mac 本机用起来：控制面和 worker 都在 Mac 上，迁服务器放到 M4。

- **GitLab**：一个项目只在一种托管上，平台按 worker 有凭据的主机认出托管。GitLab 上用 PAT（M3 是用户的个人令牌，M4 换 bot），推 `agent/*`、`spec/*`，开 MR（draft 用 `Draft:` 前缀），每分钟轮询同步状态，不做 webhook。人来合并靠 GitLab 的分支保护加平台事后检测。
- **多需求并行**：main 前进后，还在开发的需求自动 update-branch（合 main、跑门禁、前移）；合不进或门禁不过，给 agent 一次，还不行就暂停需求等人。集成分支每次前移，对同仓库的其他需求试合并，有冲突在页面上提示。
- **基础度量**：一张只追加的事件表；每次失败和 blocked 标上来源（平台、外部服务、agent、需求本身）；工期切成 agent、门禁、排队、等人四段；度量页按项目、按周汇总。
- **日志和磁盘**：日志接口不变（worker 只经 API 交，页面只经 API 读）；加保留期、磁盘告警和工作台上的状态区。

人出现的时机不变：规划、处理 blocked 或暂停、最后合并。

## User Stories

GitLab

1. As a 开发者, I want 在 GitLab 项目的 checkout 里跑 `/afk-setup` 就能接入, so that 公司 GitLab 上的仓库和 GitHub 上的一样用。
2. As a 开发者, I want 项目里的仓库在不同托管上、或主机平台不认识时，afk-setup 在登记任何东西之前停下并用中文告诉我怎么修, so that 我不会接入一半。
3. As a 开发者, I want 接入报告里看到平台令牌的用户在每个仓库上的权限（是不是成员、能不能直推默认分支、Developers 能不能合并）和该找谁修, so that 我知道找 Maintainer 改什么。
4. As a 开发者, I want 令牌的用户不是项目成员时 `plat spec confirm` 拒绝并给出同样的修复提示, so that 需求不会跑到开 MR 时才失败。
5. As a 开发者, I want 平台在 GitLab 上为每个仓库开 MR，有顺序要求的先开成 `Draft:`，提供契约的仓库合并后由平台去掉前缀, so that 合并顺序和 GitHub 上一样。
6. As a 开发者, I want 页面上看到 MR 的状态、流水线、是否有人批准、是否有人要求修改，每分钟更新, so that 不用来回切 GitLab。
7. As a 开发者, I want 换成 bot 令牌后（M4），有人用 bot 身份合并了 MR 时平台标红并通知, so that 「只有人能合并」被破坏时我会知道。
8. As a 开发者, I want 默认分支叫 `master` 的仓库照样能用, so that 不用为平台改团队习惯。
9. As a 运维（M3 是开发者本人）, I want GitLab 的 PAT 放在 `~/.afk/secrets/gitlab/<主机>`，换文件就生效，到期前 30 天页面和通知提醒, so that 令牌不会悄悄过期。
10. As a 开发者, I want 需求取消或合并后平台关掉它的 MR、删掉它的分支, so that GitLab 上不留垃圾。

多需求并行

11. As a 开发者, I want main 前进后，还在开发的需求自动把 main 合进集成分支并跑门禁, so that 我验收时看到的是基于最新 main 的代码。
12. As a 开发者, I want 收尾开始时集成分支落后 main 就先更新, so that 整体 review、联调和 MR 都基于最新的 main。
13. As a 开发者, I want 我正在验收的需求不随 main 打扰我，只有 MR 和 main 冲突时才更新, so that 我审的东西不会在眼前变。
14. As a 开发者, I want update-branch 合不进或门禁不过时 agent 先自己修一次，还不行就暂停需求、进待处理, so that 只有真解决不了的才叫我。
15. As a 开发者, I want 对暂停的需求重试（可以先自己把 main 合进去推上去）、放行（先不更新，继续派票）或取消, so that 我能按情况处理。
16. As a 开发者, I want 两个需求在同一个仓库改到同一个文件时，两个需求页面都提示「潜在冲突」和文件, so that 我能提前安排谁先合。
17. As a 开发者, I want 潜在冲突只是提示，不挡任何事、不进待处理、不发通知, so that 它不打扰正常推进。
18. As a 开发者, I want 两个项目的需求同时在 Mac 上跑, so that 平台对一个以上的项目有用。

基础度量

19. As a 平台维护者, I want 每次状态变化和人的每次操作都记成事件（谁、何时、从什么到什么、原因码、来源）, so that 度量有数据可算。
20. As a 平台维护者, I want 每次失败和 blocked 都标上来源：平台、外部服务、agent、需求本身, so that 能算平台自身的故障率。
21. As a 开发者, I want 待处理里平台和外部服务的问题单独成一组, so that 我先看自己需求的问题。
22. As a 平台维护者, I want 平台自己恢复了的失败也记下来，和要人处理的分开统计, so that 看得出自动恢复在起作用。
23. As a 开发者, I want 需求详情页有一条工期四段条（agent、门禁、排队、等人）, so that 一眼看出时间花在哪。
24. As a 平台维护者, I want 导航里有「度量」页，按项目看最近 12 周的工期、失败归因和平台故障率, so that 知道平台在变好还是变坏。
25. As a 平台维护者, I want 度量页能算出平台故障率、每周合并的 MR 数、MR 合并率、合并前要人补 commit 的比例、无人插手比例, so that 成功标准里能算的都在 M3 算起来。
26. As a 平台维护者, I want 时间线上每次 blocked 和暂停都标出来源, so that 看单个需求时也知道是谁的问题。

日志和磁盘

27. As a 开发者, I want 需求结束 90 天后它的日志被清理，页面上看到「日志已于某日按保留策略清理」, so that 磁盘不会一直涨，也不会看到莫名的 404。
28. As a 开发者, I want worker 上的沙箱原始日志 14 天、取回失败留下的 clone 30 天后自动删除, so that 未脱敏的原始日志不会一直留着。
29. As a 开发者, I want 联调环境拆除时删掉这次构建的镜像, so that Docker 不会被一次次构建塞满。
30. As a 开发者, I want 剩余空间低于 10 GiB 时页面出横幅、发一次通知，低于 5 GiB 时 worker 不再领新作业, so that 磁盘满之前我就知道，满了也不会坏在半路。
31. As a 开发者, I want 工作台底部看到日志目录大小、两边剩余空间、各 worker 最近上报时间和最近一次清理的结果, so that 平台的健康状况看得见。

接入与镜像

32. As a 开发者, I want afk-platform 自己也作为一个项目接到平台上，和试点项目共用同一个沙箱镜像, so that 不用等每仓库镜像就能让平台给自己干活。

## Implementation Decisions

### 托管类型与接入（「GitLab 适配器：MR 和轮询同步」#204）

- 同一项目的仓库托管类型必须一致。托管类型不再看地址里有没有「gitlab」（`hostKindOfUrl`）：worker 启动时把自己有凭据的主机报给平台（GitHub App → `github.com`；`~/.afk/secrets/gitlab/` 下每个文件一个 GitLab 主机），`plat init` 用仓库地址的主机名问平台。worker 也按主机名为每个仓库挑适配器和凭据，没有就报错。
- 校验发生在第一次跑 afk-setup（经 `plat init`）和中途加仓库时：主机不认识或项目混用托管，**在登记任何东西之前**停下，用中文说明每个仓库在哪种托管、怎么修（「把 GitLab 的 PAT 放到 `~/.afk/secrets/gitlab/<主机>`，重启 worker 后再跑 /afk-setup」；混用时「搬到同一种托管，或为它单独建项目」）。
- GitLab 版接入自检（`repo-access` 推广到 GitLab），加仓库时跑一次、之后每天一次：令牌的用户不是项目成员 → 红；令牌的用户能直推默认分支（`can_push`）→ M3 只提示「平台用的是个人令牌：推送和 MR 显示为〈用户〉，平台不调合并接口，但合并者是不是平台检测不出；换 bot 账号放 M4」（M4 换 bot 后改回红）；Developers 能合并 → 只提示。afk-setup 报告表的「GitHub App」列改为「托管」，每条没过的附修复说明和该找谁。**红的拦在 `plat spec confirm`**，修好后重跑 afk-setup 或等每日自检通过。
- 不改团队的分支保护。平台不推默认分支、不调合并接口，由平台保证（沿用现有测试）；换 bot 后再加上 GitLab 的硬限制。host-sync 读到 MR 的 `merged_by` 是令牌的用户就在需求上标红并通知；令牌能直推默认分支（即个人令牌）时不做这项检测，否则人每次合并都会误报。
- `packages/worker/src/slots.ts` 写死的 `refs/heads/main` 改成仓库自己的默认分支（试点在 GitLab 上是 `master`）。
- `plat tracker-doc` 的 GitLab 模板已有；afk-setup、`plat init` 的提示和报告补齐 GitLab 的说法。

### MR 和轮询同步

- 沿用每项目每分钟一次 host-sync，改成**每项目一行作业**，跑完原地改下次运行时间（现在每分钟新建一行，jobs 表 96% 是它）。上线时一次性删掉旧的 host-sync 行。
- 每个未合并 MR 读三样：MR 本身（状态、draft、head sha、`head_pipeline` 当 CI、`merged_by`、合并时间）、approvals（有人批准 = approved）、reviewers（有人 `requested_changes` = changes-requested）。不读评论，不做 ETag；429 按 `Retry-After` 推迟下一轮。
- host-sync 顺带读还有活跃需求的仓库的默认分支最新提交，和上次不同就算 main 前进（见「多需求并行」）。
- draft：开 MR 时标题加 `Draft: ` 前缀；pr-ready = 改标题去掉前缀（不用 `/ready`，免得多一条评论）；人已去掉的不动。编号存 `iid`；关 MR 用 `state_event=close`；删分支 404 当「已经没了」；开 MR 遇 409 按源分支查出已有那个。
- 多层子 group：`RepoRef.owner` 存完整命名空间路径，调用时整体转义；`parseRepoUrl` 支持多层。
- 页面、通知、验收包在 GitLab 项目上说「MR」，GitHub 上说「PR」；库和代码里仍叫 pull request。

### GitLab 令牌

- **M3 用用户自己的个人 PAT**（2026-11-09 用户定，为了不等管理员建 bot）：平台的推送、MR 都显示为用户本人；「只有人能合并」只靠平台不调合并接口，事后检测关闭（见上）。M4 换成 bot 用户（Developer）+ PAT，接入自检和事后检测恢复原样。
- 放 `~/.afk/secrets/gitlab/<主机名>`（600），worker 每次用前重读，换令牌不用重启。git 推送走 HTTPS Basic 认证，用户名 `oauth2`（2026-11-09 在公司 GitLab 上实测可用）。
- M3 不自动轮换：worker 每天读令牌到期日，剩 30 天在页面和 macOS 通知提醒，人手动换。自动轮换放 M4。
- `TokenPermissions` 在 GitLab 上忽略：令牌的能力由它的用户在项目里的角色决定。

### 多需求并行（「多需求并行：update-branch、trial-merge 和需求暂停」#205）

- **哪些需求、何时 update-branch**：running 的需求 main 每前进一次就更新，同一条集成分支最多排一个 update-branch，排队期间 main 又动了就合成一次、只合最新的 main；finalizing 的需求在收尾开始时落后 main 就先更新；awaiting-review / partially-merged 的只在托管上显示该 MR / PR 与 main 冲突时才更新；paused / cancelled 不做。
- **步骤**（和票的合并同一形状）：持集成分支锁（`integration:<仓库id>:spec/<slug>`）`merge-tree` 把 main 合成候选提交 → 候选门禁 → 通过则 `--force-with-lease` 前移，合并提交带 `Spec`、`Run` trailer。有冲突或门禁不过：释放锁，开一次 merge agent 运行（Run 不挂票，阶段 `update-branch`，不持锁）在临时分支上合 main 并解决后提交，再排一个持锁的合并步骤；第二次仍失败 → 需求暂停。
- **trial-merge**：集成分支每前移一次（票合并、final-merge、update-branch），worker 对同仓库其他活跃需求的集成分支各做一次 `git merge-tree`：只看冲突，不跑门禁，不拿锁，不挡任何事。新表每对需求 × 仓库一行（冲突文件、两边提交、发现时间），再查覆盖；没冲突或任一方合并 / 取消就删掉。两个需求页面都显示「和〈需求〉在〈仓库〉有潜在冲突：文件；后合并的一方在 update-branch 时处理」。
- 资源：worker 的 `AFK_SLOTS` 默认 2，是整台机器的上限，Mac 上保持 2。

### 暂停

- `specs.pause_reason` 从文字改成原因码 + 说明：`budget-exhausted`（现有的 agent 时间用完）、`update-branch-conflict`、`update-branch-gate-failed`。
- 暂停的需求进待处理、照发通知；不派新票，在跑的票跑完；名额释放沿用 #195。
- 人能做：**重试**（可先自己把 main 合进 `spec/...` 推上去）、**放行**（先不更新，继续派票，main 下次前进或收尾时再试）、**取消需求**。

### 事件表（「基础度量：失败归因和工期四段」#207）

- 新表只追加，和状态变化**同一事务**写入：需求、票、作业、收尾（含最终 e2e、规划提交）的状态变化，人的操作（重试、放行、批准保护路径、恢复、取消、改票），以及 host-sync 带来的变化（MR / PR 状态变化、合并、同步出错、main 前进）。host-sync 的例行轮询本身不记。
- 字段：时间、需求、票、Run、类型、从什么到什么、原因码、来源（调度器 / worker / host-sync / 页面 / CLI）、失败来源、少量附加数据。
- M3 只写入、只给度量读；通知、SSE、时间线改读事件（优化计划 2.6 第 2、3 步）放 M4。不回填历史，度量页注明「数据从某日起」。永久保留。

### 失败来源

来源写事件时按原因码算好存下，M3 不支持人工改判：

| 来源 | 原因码 |
|---|---|
| agent | `invalid-output` `no-commits` `agent-gave-up` `timeout` `gate-failed` `post-merge-gate-failed` `integration-loop-exceeded` `integration-unknown-side` `final-e2e-failed` `budget-exhausted` |
| 需求本身（含项目自己的门禁、联调、契约配置） | `merge-conflict` `protected-path-changed` `contract-copy-mismatch` `contract-change-needed` `integration-environment-failed` `update-branch-conflict` `update-branch-gate-failed`、规划提交补丁打不上 |
| 平台 / 外部服务 | `job-failed` 及作业失败默认平台；`error` 命中已知外部特征（Cursor 鉴权或限流、GitLab / GitHub 接口 5xx、npm 或镜像源不通、host-sync 同步出错）算外部服务 |
| 不计 | `upstream-cancelled` |

- 收尾和最终 e2e 的 `blocked_reason` 现在已用代码里的常量，加上库约束，和票的原因码同一张表。
- 自动恢复的失败（作业重试、以后优化计划 1.5 的自动重试）也记、也标来源；度量分「自动恢复」和「要人处理」。
- 待处理队列不分人（M3 只有一个人）：平台和外部服务来源的项单独成「平台问题」一组，排在需求问题后面。

### 工期四段与度量页

- **工期**：从需求确认到最后一个 MR / PR 合并，不含规划；合并时间用托管返回的合并时间。按墙上时间切成不重叠的四段，同一时刻按先后只归一段，四段之和 = 工期：
  1. agent：有 agent 运行在跑（implement、各 fix、review、diagnose、update-branch 的合并 agent）；
  2. 门禁：没有 agent，有 gate、merge（含合并后门禁）、e2e 在跑；
  3. 排队：都没在跑，但有可做的事在等平台（名额、worker 领取、host-sync 下一轮、收尾作业排队）；
  4. 等人：其余（blocked、暂停、MR / PR 等合并、规划提交 blocked）。
- 按项目汇总（M3 没有团队实体）、按需求合并那周归周。取消的需求不进工期，进归因。
- **平台故障率**：当周结束（合并或取消）的需求里，至少有一次「要人处理」的平台来源失败的占比，对照 3%。外部服务单列一个比例；另附按作业算的平台失败率供排查。
- **度量页**：导航第四项「度量」（工作台 / 需求 / 待处理 / 度量），选项目（默认全部），最近 12 周三块：工期（每周结束需求数、工期中位数、四段占比的堆叠条，可点进当周需求）；失败归因（来源 × 原因码，自动恢复 / 要人处理两栏）；平台故障率（每周，3% 参考线，外部服务一条，附作业失败率）。图表按仓库的 dataviz 规范画。
- **需求详情**：一条四段条（进行中的显示到目前为止）；时间线上每次 blocked、暂停标出来源。
- **M3 算的成功标准**：平台故障率；每周合并的 MR / PR 数；合并率（合并 ÷ 合并 + 关闭未合）；合并前要人补 commit 的比例（host-sync 发现合并时，比较合并时的 head 和平台最后推送的 head）；无人插手比例（确认到合并之间除合并外人零操作的需求占比）。占部门比例、评审意见有用率、回滚率、活跃团队 / 语言、「非常失望」不在 M3。
- M3 不加度量的 CLI，不导出。

### 日志、保留与磁盘（「日志的集中存储和保留策略」#208）

- 接口不变：worker 只经 `POST /worker/runs/{id}/logs` 交日志，页面只经 `GET /runs/{id}/logs` 读，`LogStore` 接口保持窄。M4 只需把 `AFK_LOG_DIR` 指到 compose 具名卷。不上对象存储（「自建的日志和对象存储选型（2026）」#201：MinIO 社区版已停维，将来需要时首选 SeaweedFS）。
- 顺手：删掉从未写过的 `runs.log_url`、`gate_results.log_url`；改掉 `log-store.ts` 里「M3 换 MinIO」的注释；一次性清掉 `~/.afk/logs` 根下按实例分目录之前留下的 `run-*`。
- 保留期（天数都可用环境变量改）：

| 位置 | 东西 | 保留 | 谁清 |
|---|---|---|---|
| API | Run 日志 | 需求合并或取消满 90 天后删；Run 记录和事件保留 | API 启动时 + 每天 |
| worker | `sandbox-logs`（原始、未脱敏、不上传） | 14 天 | worker 启动时 + 每天 |
| worker | `salvage` | 30 天 | 同上 |
| worker | 快照 | 7 天（现状） | 同上 |
| worker | 槽位 | 复用时清（现状） | — |
| worker | 联调环境构建的镜像 | 拆除时 `compose down -v --rmi local`；不碰基础镜像和平台沙箱镜像 | 每次 Run |

- 页面看已清理的日志显示「日志已于某日按保留策略清理」，不报 404。
- **磁盘告警**看剩余空间，不看百分比：低于 10 GiB 页面顶部横幅 + 一次 macOS 通知；低于 5 GiB worker 不领新作业（在跑的跑完），横幅变红 + 再一次通知；回到阈值以上自动恢复，再跌破才再通知。阈值可配置。worker 查自己 home 所在盘、API 查日志目录所在盘，各自上报（M4 机器分开也成立）。
- **工作台状态区**（页面底部）：日志目录大小、两边剩余空间、各 worker 最近上报时间、最近一次清理删了多少。完整的系统状态面板放 M4。

### 沙箱镜像

- 平台仓库里放一份平台自己的沙箱 Dockerfile，是试点前端那份（Node 22、Playwright Chromium）和 afk-platform 那份（pnpm、Postgres 服务端）的并集，锁定 Cursor CLI 版本。worker 只配这一个镜像，两个项目共用。每仓库镜像仍在 #159。

### 状态机与原因码

- 需求：`paused` 带原因码（上面三个）；update-branch 不新增需求状态，进行中由集成分支锁和作业表达。
- 新阶段 `update-branch`（merge agent 运行，不挂票）。
- 原因码到失败来源的对应放在 `@afk/shared`，事件写入和页面共用。

## Testing Decisions

照 M1、M2 的三层，尽量用最高的一层：

1. **API 层**（HTTP + 真 Postgres）：托管类型校验（混用、不认识的主机、在登记前拒绝）；`plat spec confirm` 被红的自检拦下；host-sync 每项目一行；MR 状态映射（draft 前缀、approvals、`requested_changes`、`merged_by` 是令牌的用户时标红，个人令牌时不检测；能直推默认分支只提示、不拦 confirm）；main 前进 → 哪些需求排 update-branch、排队合并成一次；暂停的三种原因码和重试 / 放行 / 取消；潜在冲突表的增删；事件同事务写入（回滚时事件也没有）；失败来源对应表；工期四段的切分（并行的票、blocked 与运行重叠、取消的需求）；平台故障率和五条成功标准的算法；日志按保留期清理和过期提示；磁盘阈值上报和停领作业。
2. **pipeline / worker 层**（临时 git 仓库，假的 agent 运行器，假的 GitLab HTTP）：GitLab 适配器的每个调用（多层子 group 转义、409、404）；默认分支不是 main 的槽位；update-branch 的 `merge-tree` → 候选门禁 → 前移，冲突走 merge agent；trial-merge 只看冲突；`sandbox-logs` / `salvage` 清理；`compose down --rmi local`（假的 docker 命令执行器）。
3. **端到端（不进自动化）**：真 Cursor、真 GitLab、真 Docker：验收需求和演练。

GitLab 上还没实测的两项，在 GitLab 适配器第一张实现票的第一步核对，并按结果选退路（PAT 走 git HTTPS、用户名 `oauth2` 已实测可用）：

- Developer 能否读 `can_push` 和保护设置（M3 的个人令牌是 Owner，读得到；换 bot 时再核对）：读不到时，接入自检改为试推一个临时分支再删掉；
- 17.3.1 上 reviewers 的 `requested_changes`：没有这个字段时，评审状态只看批准。

## Out of Scope

- 迁到公司服务器、ThinkPad worker、worker 只出站 / 能力标签 / 协议版本 / `plat drain`、新团队在服务器部署下的接入（M4，「部署形态与 worker 协议」#202）。
- 页面登录，CLI 和 worker 的凭证（M4，「身份：页面、CLI 和 worker 各怎么认证」#203）。
- 飞书通知；通知、SSE、时间线改读事件表（M4，「事件表和飞书通知」#206）。M3 沿用 macOS 通知。
- 沙箱出网白名单和容器加固（M4，#209、#211）。
- GitLab webhook（M3 用轮询）；用 GitLab issue 承载需求和票（沿用 `plat` 导入，平台就是 tracker）。
- 跨需求依赖边；MR / PR 评论返工（rework）；agent 提供方做成项目配置；#159 每仓库镜像。
- 流水线基准和回放、review 校准、MR 评审机器人、一句话任务、M4 追溯、M5 事件总线与插件和工作流、信任阶梯、角色权限。
- GitLab bot 账号（M3 先用个人令牌）、PAT 自动轮换、完整的系统状态面板、度量的 CLI 和导出、人工改判失败来源。

## Further Notes

### 建议的实现顺序（供 to-tickets 参考）

1. 事件表和写入点；原因码到失败来源的对应。
2. GitLab 适配器：托管类型识别和校验、PAT、推送、MR（draft、ready、关闭）、host-sync 每项目一行、接入自检和 confirm 拦截、默认分支不写死 `main`。第一步核对上面三项未实测的行为。
3. 多需求并行：main 前进检测、update-branch（含 merge agent）、暂停原因码与重试 / 放行、trial-merge 和潜在冲突。
4. 度量：工期四段、失败归因、平台故障率和成功标准、度量页、需求详情的四段条、待处理分组。
5. 日志保留、磁盘告警、工作台状态区、清理孤儿日志、删 `log_url` 列、`--rmi local`。
6. 合并的沙箱镜像；GitLab 版的 afk-setup / `plat init` 说法补齐。
7. 演练和验收。

第 1 步先做；第 2、3、5、6 步可以并行；第 4 步依赖第 1 步；第 3 步的暂停事件依赖第 1 步。

### 前置（2026-11-09 已完成）

1. 公司 GitLab 上建好 `xuxinghua/afk-pilot-backend`、`xuxinghua/afk-pilot-frontend`（个人命名空间，internal），默认分支 `master`，保护按公司默认（推送 Maintainers，合并 Maintainers + Developers，不允许强推）。`master` 已推入 GitHub `main` 的完整历史（后端 73 个提交、前端 29 个，两边最新提交一致）；GitHub 上的两个仓库原样保留。
2. 令牌：用户的个人 PAT（用户是两个项目的 Owner），2027-11-09 到期，放在 Mac 的 `~/.afk/secrets/gitlab/<主机>`（600）。bot 账号放到 M4。
3. 用户自己的 GitLab 账号能在 Mac 上 clone 这两个项目，用来跑 `/afk-setup` 和规划。

### 验收需求

两个项目，都在用户 Mac 上 3000 端口的平台上跑（页面看得到）：

- **项目一 `shop-gl`**（新建，试点前后端在 GitLab）：在 GitLab 的 checkout 里跑 `/afk-setup` 完整接入，老的 `shop` 项目和它的历史不动。需求「订单备注：下单时填写，列表和详情里显示，长度有限制」，跨仓库、带契约变更（契约 → 后端 → 前端 → 联调，规模和 M2 那次差不多）。
- **项目二 `afk-platform`**（在 GitHub）：接入平台仓库本身。需求取优化计划 1.6「卡住之后：一份简报三处同用，下一步给到命令」：简报生成挪进 `@afk/shared`，API 返回它，页面、`plat blocked` 共用，每个原因码给一条填好编号、可复制的命令。

两个需求都由本机 agent 跑 grill-with-docs → to-spec → to-tickets，经 `plat` 导入并确认，所以这里只定题目，不预先拆票。

**通过标准**：

1. 两个需求从确认到开出 MR / PR，人只在确认和合并时出现（自动恢复的失败不算人插手）。
2. 项目一在 GitLab 上开出两个 MR：后端的先 ready，前端的在后端合并前保持 `Draft:`，后端合并后由平台去掉前缀；需求经过 `partially-merged` 到 `merged`；轮询同步看得到 approvals 和合并。
3. 项目二在 GitHub 上开出 PR 并合并。两个需求在 Mac 上**同时**跑过一段。
4. 度量页看得到这两个需求的工期四段和失败归因（没有失败显示「无」），需求详情上有四段条。
5. 同仓库两需求的演练通过（见下）。
6. 演练清单逐项打勾，跑出来的问题修掉或记进「已知的、没有实测过的」。

### 同仓库两需求的演练

在 GitLab 的 `afk-pilot-backend` 上手写两个各 1 张票的小需求，都改同一个文件，同时跑：人先合 A，B 的页面提示潜在冲突，B 经 update-branch（必要时 merge agent）更新后照常合并；或按规则暂停，人重试后合并。

### 演练清单（手动，在 Mac 上用真实 Cursor）

- [ ] update-branch 的持锁合并步骤里杀掉 worker：锁随租约释放，重跑后集成分支只前移一次。
- [ ] 改错或吊销 GitLab PAT：接入自检变红，`plat spec confirm` 被拦，host-sync 出错记为外部服务；换回正确的令牌不用重启 worker。
- [ ] 用个人令牌时，接入自检对「能直推默认分支」只给提示、不拦 `plat spec confirm`；人合并 MR 不误报。
- [ ] 把磁盘阈值调到高于剩余空间：横幅、通知、worker 停领新作业；调回后自动恢复。
- [ ] 把日志保留天数调成 0：结束的需求的日志被清理，页面显示过期提示。
- [ ] 断开公司网络：host-sync 出错归到外部服务，恢复后自动接着同步。
- [ ] 两个项目的需求同时跑：工期四段加起来等于工期，并行时 agent 段不被等人段吃掉。

### 已知的、没有实测过的

- GitLab 上的两项（见 Testing Decisions），在实现第一步核对。
- 合并的沙箱镜像能否同时满足 Playwright 和 afk-platform 的门禁（Postgres 临时实例）；afk-platform 的门禁在沙箱里跑一次要几分钟，比试点慢得多。
- Mac 的 Docker 虚拟机 7.8 GiB 内存同时跑两个沙箱加一个联调环境是否够用。
