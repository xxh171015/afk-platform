# 操作体验：控制塔、叫人回来、规划文档进沙箱

2026-11-01 · 草稿，待用户确认后发布。2026-11-02 补了页面一对一复刻（活路由、视觉层、Run 页签）。依据：[design.md](../design.md)、[m2-platform.md](m2-platform.md)、[m1-tech-stack.md](../m1-tech-stack.md)、[GLOSSARY.md](../../GLOSSARY.md)、[ADR 0004](../adr/0004-control-tower-visual-layer-not-tanstack-start.md)，以及地图 [AFK 研发平台：走到操作体验可交付](https://github.com/xxh171015/afk-platform/issues/125) 上各决策票的结论。术语以 GLOSSARY 为准。平台里的 **Ticket** 只指平台实体。

这不是 M3。M3 仍是迁公司服务器和 GitLab CE。

## Problem Statement

M2 已经能把一个跨仓库需求从拆票跑到验收，但人打开页面时仍要自己拼「现在该看什么」。首页是一张需求表，不是「有没有事要我做、正在跑的正不正常、有什么可以验收」。需求页看不出流水线走到哪一步，收尾 Run 找不到。票上的简报是原始 JSON。被叫回来时，macOS 通知还没有，页面上也不能带一句话重试或改正文。规划阶段写进 GLOSSARY / ADR 的字，agent 只有在人先把它们推进 main 之后才读得到。

可用性反馈确认要做的是：主动叫人、被叫回来能处理、页面按控制塔原型改版、规范文档跟着需求走、执行中看得懂、确认前预检。

## Solution

把操作体验补齐到可以交给 to-tickets 实现，人仍然只在规划、处理 blocked、最终合并时出现：

- 页面按冻结原型**正在渲染的路由**一对一复刻（布局、字号、间距、密度、颜色、亮/暗、中文文案、空/错/加载、快捷键；动效等价）：工作台四象限、需求六步流程条和五个嵌套页、独立 Run 页（日志 + 提示词 / 结构化输出 / 提交）、结构化简报。技术栈仍是连 Hono 的 Vite SPA；视觉层按 [ADR 0004](../adr/0004-control-tower-visual-layer-not-tanstack-start.md) 从原型搬进 `packages/web`。
- 状态变化时 API 发 macOS 本机通知（osascript，点不开页面）；页面资源靠 SSE `invalidate` 失效再 GET，断线退回轮询。Run 日志仍按 offset 切片。
- 被叫回来时，待处理和票页能带 Retry note 重试、改正文；追加票、改依赖、取消整个 Spec 仍走 `plat`。
- 规划提交作为规划仓库集成分支的起点；其他仓库的票只读挂 `/context/domain/`。验收包写入该仓库 PR 描述。
- 确认拆分前给出预检（缺规划提交标黄，不硬拦）。

冻结原型：Lovable 项目 `913e95a9-cb98-4785-8291-4749ef1ec061` **正在渲染的路由**（仓库内副本 [`prototype/control-tower`](https://github.com/xxh171015/afk-platform/tree/prototype/control-tower/prototype/control-tower)）。一对一对照这份冻结物，不以线上 preview 为准（会漂移）。不把 TanStack Start / mock 应用合进 `main`。

## User Stories

工作台与导航

1. As a 开发者, I want 打开页面先看到工作台而不是一张需求表, so that 我立刻知道该不该插手。
2. As a 开发者, I want 工作台四象限是等你处理、正在运行（阶段 + 耗时 + 偏慢）、等你验收、最近完成的 Spec, so that 结论在前、细节按需。
3. As a 开发者, I want 侧栏和顶栏都是「工作台 / 需求 / 待处理」，待处理旁有等待数量, so that 名称不和总览修复撞车，导航和原型同一套。
4. As a 开发者, I want 每个可看的东西有真实路径地址（`/`、`/waiting`、`/specs`、`/specs/:id` 及其 `/description` `/tickets` `/delivery` `/timeline`、`/tickets/:id`、`/runs/:id`）, so that 我能把「交付」或某一 Run 发出去。
5. As a 开发者, I want `g h` / `g b` / `g s`、`⌘K`、`?` 快捷键, so that 手不离键盘；输入框打开时不触发。

需求页

6. As a 开发者, I want 标题下看到人话六步 `草稿 → 确认 → 运行 → 收尾 → 开 PR → 验收合并` 和票进度 n/m, so that 我不用解 Spec 状态机。
7. As a 开发者, I want 五个嵌套页是概览 / 需求说明 / 票与依赖 / 交付 / 时间线, so that 读需求和看进度分开；交付按仓库出卡，收尾每一步带对应 Run。
8. As a 开发者, I want draft 的需求在概览仍能确认拆分，确认前看到预检（导入告警、缺规划提交标黄）, so that 规划动作还在页面上。

Run、票、待处理

9. As a 开发者, I want 打开 `/runs/:id` 看到阶段、次数、结果、耗时，日志按思考 / 工具卡分组（完成的工具默认收起；review / final-review 的两轴按 session 分开），下面三个页签是提示词 / 结构化输出 / 提交, so that 我能看出 agent 在干什么、被喂了什么、交出了什么；原始事件流在卡内默认可展开；没有数据的页签仍在，显示空状态。
10. As a 开发者, I want 票上的 Runs 表只留编号、阶段、结果、耗时、开始时间，行点进 Run 页, so that 打开票不预载全文，打开 Run 页一次拿齐。
11. As a 开发者, I want blocked 时看到结构化简报（原因码中文结论、步骤、证据、推荐动作），证据能点进 Run, so that 我不用读 JSON。
12. As a 开发者, I want 在待处理或票页带一句话重试、改正文，危险操作二次确认, so that 被叫回来不必先开终端。这两处原型没有，页面上仍要有，允许不像原型。
    12a. As a 开发者, I want 票侧栏看到内容版本历史，点开对比 Dialog, so that 我能看见 Content version 之间标题、正文、验收标准的差异；旧正文走已有的 `GET /tickets/{id}?version=`。

叫人与刷新

13. As a 开发者, I want 七类状态变化各发一条 macOS 通知（标题 + 一行人话 + 平台链接）, so that 我人在电脑前能被叫回来；点通知打不开页面。
14. As a 开发者, I want 工作台、需求、票、Run、待处理在有变化时几乎马上刷新, so that 我不用傻等 3～5 秒；SSE 断了才退回轮询。

规划文档与验收包

15. As a 开发者, I want grill 改的 GLOSSARY / ADR 作为规划提交成为规划仓库集成分支的起点, so that 文档和代码同一条 PR，不必先推 main。
16. As a 其他仓库里的 agent, I want 在 `/context/domain/` 读到这次规划提交上的 GLOSSARY 和 ADR, so that 前端票也说同一种话。
17. As a 开发者, I want 验收包出现在该仓库 PR 描述里（本仓库一节 + 合并顺序 + 联调）, so that 我在 GitHub 上验收时不必再回平台抄一遍。

## Implementation Decisions

### 信息架构（[控制塔原型是否成为 packages/web 的信息架构](https://github.com/xxh171015/afk-platform/issues/126)）

按冻结原型**正在渲染的路由**写进 `packages/web`，视觉一对一（见 Solution）。不复活已不用的 `SpecOverview` / `SpecPrPanel`。不把 TanStack Start 或 mock 应用搬进来；视觉层怎么搬见 [ADR 0004](../adr/0004-control-tower-visual-layer-not-tanstack-start.md)。

导航文案「需求 / 待处理」是给人看的名字，实体仍是 Spec 和 blocked 队列。首页叫**工作台**。控制塔日常身份是 GitHub 仓库 `owner/name`，不是平台 Project 登记名（手册示例里的 `shop` 只是 CLI 一次性容器）。列表「项目」列、工作台副标题、面包屑第一段都不渲染 `projects.name`。需求列表默认按新建时间倒序（`startedAt` 即 `created_at`；API 已 newest first），点状态 / 进度列仍可改排。面包屑是 Linear 式：`{owner} › 需求 › S-n 标题▾ › ⋯`；票页带所属需求（`{owner} › 需求 › S-n▾ › T-n 标题▾`）。`⋯` 复制编号/链接、在 GitHub 打开（有 PR 优先）、跳到五个嵌套页；票上另有改正文（仅 pending/blocked）。不做星标。

侧栏 + 顶栏、`≤640px` 断点（侧栏只留图标、隐藏搜索文字和 kbd、图 520px）、默认暗色、`localStorage` 键 `afk-theme`（不跟系统）、Inter + JetBrains Mono、危险操作 AlertDialog、图节点 Sheet、toast sonner：都跟冻结原型同一套。

中文主文案；偶然英文（例如运行表头 `Display ID`）写成「编号」。英文码留在 `title` / 等宽字。不增加枚举值。

六步与 Spec 状态：

| Spec 状态                              | 流程条当前步                 |
| -------------------------------------- | ---------------------------- |
| `draft`                                | 草稿                         |
| `planned`                              | 确认                         |
| `running`                              | 运行                         |
| `finalizing` 且尚无 PR                 | 收尾                         |
| `finalizing` 且 PR 正在开或已开        | 开 PR                        |
| `awaiting-review` / `partially-merged` | 验收合并                     |
| `merged`                               | 六步均完成                   |
| `paused` / `cancelled` / `reworking`   | 横幅；停在进入异常前的那一步 |

时间线只用这一组事件：确认拆分、票开始、门禁通过或失败、review 意见条数、票合并进集成分支、票 blocked、进入收尾或收尾步骤变更、开 PR 或 draft 转 ready、验收包生成、追加票、暂停或恢复、合并进 main。不自创。

结构化简报（票顶和待处理卡片共用）：

```ts
type StructuredBrief = {
  reason: BlockedReason;
  step: string;
  summary: string; // 中文结论
  evidence: {
    failingTests?: string[];
    command?: string;
    lastLogLines?: string;
    conflictFiles?: string[];
    findingsCount?: number;
  };
  recommendedAction: string;
};
```

字段按原因码有则填；没有的键不上屏。点证据进对应 Run。

状态徽标主文案中文、英文码在 `title`。不增加枚举值。SHA 只显示前 7 位，复制按钮仍复制完整值；有仓库 URL 时短 SHA / 分支 / 仓库名外链到 GitHub（或 GitLab）浏览页，PR 用已存的 `html_url`。墙钟用 `Asia/Shanghai` 的 `yyyy-MM-dd HH:mm`（`<time datetime={iso}>`），悬停带秒；`formatElapsed` / `formatDuration` 仍表示耗时。徽标不只靠颜色。

需求说明按 to-spec 的 `##` 切段，中文节名 + 英文原名；票正文同样切 Parent / What to build / Acceptance criteria / Blocked by。Markdown 用设计 token 排版，目录 class 是 `markdown-toc`（不是 Tailwind `contents`）。编辑、diff 仍是纯文本。Run prompt 用同一套 Markdown 排版（不切中文章节、不做 SpecBody），长文开目录。HTML 注释（覆盖层的 skills SHA 标记）不上屏。

时间线按上海日历日分组的竖轨；`pr-opened` / `pr-ready` / `merged` 链到 GitHub PR，有 `runId` 的链到 Run 页。不新增事件种类。`resume` 若 API 不发，UI 静默丢弃。

六步流程条映射不变；每步挂已有事实（票数、确认时间、卡住数、收尾步、PR 草稿/CI、验收包 / 合并顺序被打破）。未到达的步不可点；已到达的步落到不同锚点（草稿/确认 → 概览，运行 → 票与依赖，收尾/开 PR/验收合并 → 交付页对应章节）。勾和实心圆表示生命周期，底边表示当前页。确认后的概览是属性区（仓库、规划提交、集成分支、票进度、PR、最近事件、需求摘录）+ 依赖图，不再挂「没有黄项」。交付页「验收包」是独立一章。票与依赖上图下卡片。

旧验收包缺数组字段时 API 先 coerce 再必要时重建；交付页对 pack 数组一律按空数组渲染，不再对 `.length` 崩溃。

「偏慢」：当前阶段耗时超过该项目同类阶段历史均值 2～3 倍；没有同类历史则不出标记。不上「预计还需」。

票详情不做「改动 / 版本历史」标签页，也不展示票分支相对集成分支的 diff。内容版本历史在侧栏，对比用 Dialog；旧正文走已有的 `GET /tickets/{id}?version=`。

页面写操作以「被叫回来处理 blocked」为界：带说明重试、待处理上已有按钮、pending / blocked 票在页面上改正文。原型没有改正文和 Retry note 输入，这两处仍要有，允许不像原型。追加票、改依赖、取消整个 Spec 仍走 `plat`。删掉 M1 独有、原型没有的界面（例如「agent 读到的原文」开关）。

### 页面技术栈（[packages/web 用原型那套栈还是在现有 Vite SPA 上重画](https://github.com/xxh171015/afk-platform/issues/134)、[ADR 0004](../adr/0004-control-tower-visual-layer-not-tanstack-start.md)）

不引入 TanStack Start。页面继续 Vite SPA，`:5173`，只依赖 `shared`，打 Hono。一对一的是效果，不是把 Start 工程换成 `packages/web`。

- 路由：TanStack Router **文件路由**（`packages/web/src/routes/`），真实路径如上。旧 `#/specs/3` 不做兼容跳转。
- 样式：Tailwind 4；设计 token、`app-shell`、实际用到的原型 `afk` 组件搬进 `packages/web`。
- 组件：shadcn new-york，只拷贝页面实际 import 的文件。实际用到的是 button、input、dialog、alert-dialog、command、select、sheet、tabs、tooltip、skeleton、checkbox、sonner、dropdown-menu。状态徽标、卡片、表格自己用 Tailwind 画。禁止整包搬 Lovable 的 46 个 `components/ui`。不用 MUI / Mantine。
- 留下：React 19、TanStack Query、`@xyflow/react`、openapi-fetch、Testing Library 假 HTTP、Biome。

`docs/m1-tech-stack.md` 的「页面」一行按上表改。栈本身仍是 issue 134；搬视觉层记在 ADR 0004。

### Run 日志（[Run 日志里 Cursor 事件流的实际形状](https://github.com/xxh171015/afk-platform/issues/127)）

日志是 Cursor stdout NDJSON 和 worker `stageLog` 混在一个纯文本文件里。上屏映射用包装键，不沿用原型 `classifyLogLine`。页面先分组再画成 Cursor 式卡片，不是一行一个 NDJSON：

| 来源                                                                                                                | 上屏                                       |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `thinking` delta 按 session 拼到 `completed`                                                                        | 一块「思考」，耗时用首尾 `timestamp_ms`    |
| `tool_call` 按 `call_id` 把 `started` / `completed` 合成一张卡                                                      | 读取 / 修改 / 运行命令；完成的默认收起     |
| `readToolCall` / `globToolCall` / `grepToolCall` / `lsToolCall` / `semSearchToolCall` / `deleteToolCall`            | 读取；grep 标题去掉 `\.` `\b` 这类正则转义 |
| `editToolCall`                                                                                                      | 修改                                       |
| `shellToolCall`                                                                                                     | 运行命令                                   |
| `assistant` 且文本在 `message.content`                                                                              | agent 说明，正文默认展开；「原始事件」默认收起 |
| `result`                                                                                                            | 会话头「工作了 …」（`duration_ms`）        |
| `system` / `user` / `retry` / `connection` / `interaction_query` / `getMcpToolsToolCall` / `hookAdditionalContexts` | 不上屏（prompt 在页签里）                  |
| worker 前缀行（`gate:` / `implement:` / `e2e:` / `merge:` / `environment:` / `result:` / `final-review:` 等）       | 运行命令                                   |
| `--- name ---` 及其后直到下一前缀或 JSON 的输出                                                                     | 挂在该步下，默认收起                       |
| 被 16 KB 切断、无法 `JSON.parse` 的 `tool_call` 行                                                                  | 从行首恢复 `call_id` / 工具 / args，并回已有工具卡；对不上才标「截断的事件」 |
| 其余 JSON                                                                                                           | agent 说明（标题用 `type` / 工具名）；卡内「原始事件」默认可展开 |

没有顶层 `name`，没有 `writeToolCall`。review / final-review 两轴共用一份日志、行上没有轴标签：按 `session_id` 分成 Standards / Spec 两段（从被隐藏的 `user` 文案认轴）。继续 `GET /runs/{id}/logs?offset=`，跑完停。日志区限高、内部滚动，下面三个页签不用把整份日志翻完。未结束时跟到底，人往上翻就停。

### Run 页签（提示词 / 结构化输出 / 提交）

三个页签始终在；没有数据就空状态，不藏页签。打开票不预载全文，打开 Run 页一次拿齐。

只扩 `GET /runs/{id}`，原样带上已有列，不进票上那张 Runs 表，不为页签新建资源：

- `prompt: string | null` — Run prompt（门禁和合并没有）
- `output: unknown | null` — Structured output；不合法时是当时的原始 payload
- `commits: string[]` — 这次 Run 写下的 SHA

提交只渲染 ShaChip，不造 message、不读 git。结构化输出用 JsonTree 展示真实 JSON，不改造成原型 mock 的 `{summary, outcome, nextAction}`。

### 通知（[通知的第一渠道和事件](https://github.com/xxh171015/afk-platform/issues/130)、[本机 Node 进程怎么发 macOS 通知](https://github.com/xxh171015/afk-platform/issues/128)）

第一期：macOS 本机通知，本机 API 进程发，渠道做成适配器。`osascript` 的 `display notification` 发标题和正文；不配签名 `.app`，点通知打不开 URL。Focus 或系统关了通知时失败静默。不接 Webhook / 邮件，不做收件箱。等人的事实仍以待处理队列为准。

状态变化发一次，不心跳、不合并。七类：

1. 票进入 blocked → `/tickets/:id`
2. 收尾或 Final e2e 进入 blocked → `/specs/:id/delivery`
3. Spec 进入 paused → `/specs/:id`
4. Spec 进入 awaiting-review（验收包和 PR 一条：「可以来验收了」）→ `/specs/:id/delivery`
5. 因 Merge order 保持 draft 的 PR 被转 ready → `/specs/:id/delivery`
6. Spec 变成 merged → `/specs/:id`
7. 待处理里其余项（PR 被关或读不出、清理失败、转 ready 三次失败）→ `/waiting`

标题是事件类型；正文是显示编号 + 标题 + 一句原因，末尾带上述平台 URL。不是结构化简报，也不是验收包。

### 页面刷新（[页面刷新用 SSE 还是继续轮询](https://github.com/xxh171015/afk-platform/issues/135)）

资源刷新用 SSE 作主通道，不是 WebSocket，不是 M5 事件总线。

- `GET /events`：`text/event-stream`。事件名 `invalidate`，JSON `{ specId?: number, ticketId?: number, runId?: number }`，字段有则填。
- 前端失效对应查询；只要带了任一 id，同时失效工作台和待处理。三个 id 都空时只失效工作台和待处理。
- API 在提交了页面能看见的状态变化时发（票 / Spec / Run / 待处理 / PR）。**不**在日志 chunk 追加时发。
- 单进程内存订阅。每 15 秒一条 SSE comment 保活。
- SSE 连着时，资源查询关掉 `refetchInterval`。断线：列表和工作台 5 秒、详情 3 秒（与现在相同）。日志始终 800ms offset（追加仍不发 `invalidate`），直到 `finished && nextOffset >= size`。
- 一次失败的请求不能把正在看的页抹掉。

### 规划提交（[规划产出的规范文档怎么进到 agent 面前](https://github.com/xxh171015/afk-platform/issues/131)、[ADR 0003](../adr/0003-pointers-not-copies-include-sandbox-mounts.md)）

规范类文档走规划提交，不靠先推 main。

> 下面「人打提交、推到 `plan/<id>/<slug>`、confirm 核 SHA」的做法已被 [ADR 0005](../adr/0005-planning-docs-go-with-the-spec-committed-by-the-platform.md) 取代：confirm 带上未提交的改动，由平台提交。

- grill 改的 `GLOSSARY.md`、`docs/adr/`、规划仓库的 `AGENTS.md` 打成一次提交。人（或规划阶段的 agent）把该提交推到 `plan/<id>/<slug>`。
- `plat spec confirm` 在规划仓库工作区里核 SHA：已推送、是默认分支的后代、本地这些文件没有未进该提交的改动（`--force` 除外）；核过就登记，不替人 commit、不建集成分支。
- 页面确认不读本地 git：有规划 SHA 就用，没有就从默认分支切。确认前预检把「未做规划仓库 CLI 检查」标黄，不硬拦。改过规范文档的必须在规划仓库里 `plat spec confirm`。
- 规划提交是规划仓库这个 Spec 集成分支的起点。文档和代码同一条 PR；Spec 取消则跟分支一起丢。
- 同一 Spec 里其他仓库的票：按规划 SHA 把规划仓库的 `GLOSSARY.md` 和 `docs/adr/` 只读挂到 `/context/domain/`（和契约同一套路）。规划仓库自己的票不挂。不送 `AGENTS.md`，不整仓挂 `/refs`。
- 过程类文件（to-spec 的 spec、to-tickets 的票目录）写到仓库外，例如 `~/.afk/planning/<spec>/`，不进 git。Tracker 文档改成这样写。平台仍是 spec 和票的唯一来源。

设计原则第 4 条改表述、不改精神：原文只在仓库；平台只记指针和 SHA；prompt 只放路径；`/context/contract/` 和 `/context/domain/` 是该指针在沙箱里的只读挂载。

### Retry note（[带说明重试：说明放哪、动不动内容版本](https://github.com/xxh171015/afk-platform/issues/132)）

Retry note 不是票内容，不加 Content version，只对紧接着那一次 Run 有效。有则渲染 `/context/note.md`，没有就不挂。覆盖层：有就读，当成人对这次运行的指示，不当成改票。这段字记在用到它的那条 Run 上。再重试若不写，新 Run 没有说明。不写进 `ticket.md`，不写进 prompt 正文。

`continue` / `restart` / `plat spec retry-final` 都可选带；空字符串当没有。`resume` 和 `waive-final` 不带。页面和 `plat ticket retry` / `plat spec retry-final` 都能写。

### 验收包进 PR（[验收包写进 PR 的形态](https://github.com/xxh171015/afk-platform/issues/133)、[GitHub App 开出的 PR 之后还能不能改描述和评论](https://github.com/xxh171015/afk-platform/issues/129)）

写入该仓库 PR 的**描述**，不发评论。开 PR 时描述仍是现在的 Spec、本仓库票列表、平台不合。全部 PR 记下、验收包生成之后再 PATCH：用标记围住平台写的段落，标记外的人改动保留；找不到标记就附在末尾，不整段覆盖。标记里的字下次会被平台盖掉。包若再保存，按同样规则更新。超 GitHub 描述上限则描述里留摘要加平台该需求交付页链接。

每个 PR 只带：合并顺序、本仓库那一节（验收标准、findings、门禁、不确定点）、联调一节（有就写；放行失败的顶在最前）、平台链接。别的仓库的验收标准不抄过来。未验证的验收标准排在已验证前面。不做折叠，不做按票看 diff。平台仍然不合并 PR。现有 Pull requests 写权限足够 PATCH 描述。

### 确认前预检

确认拆分前，页面概览和 `plat spec confirm` 的输出列出：导入告警、模块重叠、缺规划提交（黄）、规划仓库工作区相对规划提交不干净（黄，仅 CLI）。黄的不阻止确认。已有的硬校验（无票、图不合法）照旧拒绝。

### 默认写进、不再另开决策票的

收尾 Run 在交付页可见；Runs 表按上面瘦身；中文状态；SHA 七位；亮暗色（默认暗色）、上海墙钟、骨架/空/错误、危险操作 AlertDialog。信息架构仍跟冻结原型的活路由走，但项目身份、Markdown 排版、时间线轨、面包屑和六步 caption 按本节覆盖冻结视觉。不上截图像素 CI。

## Testing Decisions

照 M1 / M2 的三层，尽量用最高的一层。不另写 shop 跨仓库验收需求：这一期验的是平台自己。

1. **API 层**（HTTP + 真 Postgres）：`invalidate` 在票 / Spec / Run / 待处理变化时发出、日志追加不发；规划 SHA 登记与脏工作区拒绝；Retry note 进下一次 Run 的 bundle、不加 Content version；PR 描述按标记 PATCH、人改的标记外保留；通知适配器接到七类事件（测试里不真调 osascript，缝是适配器）；`GET /runs/{id}` 带上 `prompt` / `output` / `commits`，票详情的 `runs` 数组仍不带这三项。`GET /specs` 与详情带 `repos[]`；票与 Run 带 `repoUrl` / `hostKind`；不完整的旧验收包 coerce 或缺字段重建。状态机表格不因此增加状态。
2. **页面层**（Testing Library + 假 HTTP）：视图映射纯函数——六步当前步与 caption / href、横幅、工作台分块、结构化简报、时间线拒收未列事件、日志动作类型与分组（思考合并、工具配对、隐藏 system/user、审查双轴按 session 分开）、中文状态、SHA 七位、上海墙钟、`invalidate` 该失效哪些 query key。列表「项目」列是 GitHub `owner/name` 且按它筛选。需求说明 / 票正文中文章节。Run prompt 是 Markdown。交付页能渲染缺数组的旧 pack。面包屑兄弟切换与 ⋯。路由表与地址清单一致。Run 三页签在、空数据走空状态。不测 shadcn 内部、不测样式、不做截图像素对比。
3. **端到端（不进自动化）**：本机点通工作台 → 需求交付上的收尾 Run → Run 页（日志 + 三页签）→ `⌘K` `R-n` → 票顶简报进 Run；blocked 带说明重试一次；改过 GLOSSARY 的 Spec 用 CLI confirm 登记规划提交。并排冻结原型对照：工作台、待处理、需求列表、需求五页、票详情（含版本 Dialog）、Run、⌘K、`?`、确认拆分、blocked 操作（改正文和 Retry note 允许不像原型）。通知在关系统通知时允许静默。

## Out of Scope

- 票详情「改动 / 版本历史」标签页；blocked 时展示票分支相对集成分支的 diff。内容版本对比是侧栏 + Dialog，不是标签页。
- 「预计还需」和真实预计完成时间统计。
- 为提交页签去 git 取 message，或把 Run prompt / Structured output 放进票详情的 `runs` 数组。
- 通知的 Webhook、免打扰合并、夜间汇总、每日摘要、收件箱、点击通知打开页面（签名 `.app`）。
- 指标页、自动复盘、从反复出现的问题里提炼规范。
- M3–M5：公司服务器、GitLab CE、多 worker、MinIO、登录与权限、事件与插件、`plat context`、`rework`、`update-branch`、`trial-merge`、多个需求并行。
- 系统状态面板、磁盘清理、`plat drain`、CLI 改进（`plat spec watch`、`plat use`、`plat open`、命令补全）。
- 把 Lovable 的 TanStack Start / mock 应用合进 `main`；在这张 spec 里另做一版操作体验原型。视觉层按 ADR 0004 搬进 `packages/web`。
- Cursor 的 token 用量与成本统计。
- 页面上追加票、改依赖、取消整个 Spec。

## Further Notes

### 建议的实现顺序（供 to-tickets 参考）

1. `shared`：Retry note、规划 SHA、`invalidate` 载荷、结构化简报形状、`GET /runs/{id}` 的 `prompt` / `output` / `commits`；改 `m1-tech-stack` 已在本文。
2. API：`GET /events`、状态变化发 `invalidate`、通知适配器、规划 SHA 登记、Retry note 进 bundle、PR 描述标记 PATCH、确认预检字段；Run 详情带上三列。
3. worker：渲染 `/context/note.md`、`/context/domain/`；覆盖层加「有 note 就读」。
4. CLI：`plat spec confirm` 核规划提交；`ticket retry` / `spec retry-final` 可选 `--note`；tracker 模板改为过程文件进 `~/.afk/planning/`。
5. `packages/web`：按 ADR 0004 搬视觉层，按冻结原型活路由一对一；接 SSE 与页面写操作（含改正文、Retry note）。
6. 人手点通清单（含与冻结原型并排对照）。

第 5 步可以在第 2 步的假 SSE 上先画；接真 API 放最后。具体拆成几张 Ticket 由 to-tickets 定。

### 验收

在本机已有项目（试点 shop 或任意跑过 M2 的项目）上：

- 工作台四象限、侧栏/顶栏和冻结原型一对一；需求五个嵌套地址可分享；独立 Run 页能打开，三页签在（空则空状态）。
- 一张票进 blocked：通知发出（或系统关通知时静默）、待处理和票页是结构化简报、带 Retry note 的 continue 让下一次 Run 读到 `/context/note.md`。
- 改过规划仓库 GLOSSARY 的 draft：页面确认标黄；CLI confirm 在脏工作区拒绝、提交并推送 `plan/<id>/<slug>` 后登记 SHA；该 Spec 里非规划仓库的票沙箱有 `/context/domain/`。
- 开出的 PR 描述含标记围栏的本仓库验收包；人在标记外改的字还在。
- SSE 断开后列表仍 5 秒刷新，连上后不再盲轮询资源。
