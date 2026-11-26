# 在控制塔里审代码

**技术方案 · 已定 · 2026-11-26**

共同理解见 grilling：人审意见以平台为准（[ADR 0012](../adr/0012-review-comments-are-platform-authoritative.md)）。下面按该理解写成实现方案。

现在人要验收一个需求，得从控制塔跳到 GitHub / GitLab 看 diff、写评论，平台读不到评论的内容，改动只能靠在规划机器上追加票。这份方案让人在控制塔里找到等着审的需求，按导读看完全部代码改动，在代码上写意见，一次提交给平台，由 agent 在集成分支上改完、过门禁、更新 PR，需求回到等人验收。合并仍在代码托管上做（或者按 ADR 0011 自动合并）。

本次实现的范围：

| 部分                  | 内容                                                                                                                                                              |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A · 审查页            | worker 用 git 算 PR 的 diff 和逐行归属；页面按目录或按票看改动，搜索和过滤文件，展开上下文，标已看，看「上次审后又改了什么」；右栏是合并前清单、需求与票、Finding |
| B · 导读              | 按需求 → User Story → 票（依赖顺序）→ 改动组织成章节，用 agent 当时写的说明和决定解释每一段，点进去跳到对应的 hunk                                                |
| C · 待审列表          | 跨项目列出等人审、审到一半、返工中、看完待合并的需求，组内按风险排序                                                                                              |
| D · 人审意见与 Rework | 在 diff 上写意见，提交一次修改要求；每个有意见的仓库跑一次 Rework，合回集成分支，更新验收包和 PR，需求回到 awaiting-review                                        |
| E · 两处小修          | 交付页「平台从不合入」的旧文案；worker 自动合并前重读 PR                                                                                                          |

不在本次范围：在平台里合并、用人自己的身份在托管上提交正式 Review、拉托管上评论的正文、并排对照和语法高亮、给 Finding 加文件和行号、只留记录不交给 agent 的「纯评论」。理由见第 12 节。

## 1. 从一次验收看使用体验

需求 S-70 收尾完，开了一个 PR，进入 awaiting-review。

1. 人打开顶栏的「待审」。S-70 在「等你审」一组，排在前面：它有 2 条待人定的决定，改了 1 个保护路径。行上写着等了 40 分钟、1 个 PR、+412 / −38 行。
2. 点进去是需求的「审查」标签，默认打开「导读」。第一节是需求在做什么和它的 User Story；后面按票的依赖顺序，每张票一节：票负责的 User Story、验收标准和验证状态、agent 实现时写的说明、它记下的决定，下面列出这张票改的 hunk。最后是收尾修复和设置、规划提交，以及没有归属的改动。
3. 人从导读点进 T-301 的第一个 hunk，切到「变更」视图。左边文件树切到「按票」，只看 T-301 的 8 个文件；中间是 diff，展开某个 hunk 上面 20 行上下文；右栏切到「需求与票」，对照 T-301 的验收标准，切到「Finding」看这张票审查时提过什么。看完一个文件就勾「已看」，导读里这一节的进度跟着走。
4. 在某一行点行号写意见「这里空列表要返回 200 和 `[]`，不是 404」；在另一个文件头写「这个函数名和 GLOSSARY 不一致」；在 PR 层面写「迁移脚本要能重复跑」。意见先是草稿，只存在平台里。
5. 点「提交修改要求（3）」。需求进入 finalizing，PR 转成草稿，不再考虑自动合并。PR 上出现一条平台的汇总评论，列出这 3 条意见，标「处理中」。待审列表里 S-70 移到「返工中」。
6. 平台在这个仓库跑一次 Rework：agent 读到这 3 条意见和它们挂着的代码，改集成分支，逐条交代处理结果。改动按收尾的合并流程过门禁、合回集成分支，命中条件时走 Recheck。
7. 收尾结束：验收包多了「人审意见」一节，逐条写着已处理（附 agent 的说明）或没处理（附原因）；PR 描述和汇总评论同步更新；PR 转回 ready；需求回到 awaiting-review，照常发飞书。待审列表里 S-70 回到「审到一半」。
8. 人再打开审查页，顶部提示「上次审的是 `a1b2c3d`，现在是 `e4f5a6b`」。导读多了一节「修改要求 #1」，列出 Rework 改的 hunk 和逐条处理结果；切到「上次审后」只看被改过的 3 个文件，「已看」标记在这 3 个文件上自动失效。看完满意，点链接去托管上合并。

意见没处理好就再写、再提交，每次提交是一次新的修改要求，跑一次新的 Rework。意见涉及新行为、契约或跨仓库时，照旧在规划机器上用 `plat tickets import --append` 追加票。

## 2. 术语、决定和要改的文档

实现的第一张票只改文档，后面的票按它写代码。

**GLOSSARY 新增**（放在「验收」一组，`Acceptance pack` 后面）：

- **Review comment（人审意见）**：人在控制塔审查页写下的一条意见，属于一个 PR，挂在它某个版本的一行、几行或一个文件上，也可以只挂在 PR 上。由 Rework 处理，不是 Finding，不进 Finding 的处理结果。_Avoid_：评论（托管上的评论是另一回事）、review 意见（那是 Finding）。
- **Change request（修改要求）**：人一次提交的一组人审意见。提交后需求进入 finalizing，每个有意见的仓库跑一次 Rework。一个需求可以有多次，按顺序编号。_Avoid_：返工单、打回。
- **Rework（返工运行）**：按一次修改要求改一个仓库集成分支的 agent 运行，是收尾的一步。从集成分支最新提交切出 `agent/<id>/S-<n>-rework-<k>`，改完按收尾的合并流程合回。_Avoid_：返工票（追加票是 Ticket，Rework 不是）、re-fix。
- **Review revision（审查版本）**：平台为 PR 的一个 head 提交算出的一份 diff 和逐行归属，不随 PR 再变。「已看」标记、人审意见和导读都挂在某个审查版本上。
- **Review guide（导读）**：一个审查版本的阅读顺序：按需求、User Story、票的依赖顺序、收尾和修改要求分节，每节用平台已有的记录说明这段改动为什么这样做，并指向对应的 hunk。由平台按记录拼出，不跑 agent。_Avoid_：walkthrough、总结。
- **Review queue（待审列表）**：所有等人审、正在返工、看完等合并的需求。不是待处理（待处理是 blocked 的票和收尾）。_Avoid_：收件箱、inbox。

GLOSSARY 里「review 意见」一条补一句：人审意见不是 review 意见。Append 一条里「已经开了 PR、人还没合并时也可以追加」后面补：也可以提交修改要求，需求进入 finalizing。这些已写入根目录 `GLOSSARY.md`。

**ADR 0012：人审意见以平台为准，由 Rework 修改。** 已写入 `docs/adr/0012-review-comments-are-platform-authoritative.md`。要点：

- 人在平台写意见，平台是这些意见的权威来源；托管上只放一条平台维护的汇总评论存档。不逐条同步成托管的行内讨论，不接个人 OAuth。
- 修改要求不触发审查：Rework 只经过门禁和 Recheck（由确定性条件触发），不重跑 final-review。审它的人就是写意见的人，「审查只跑一次」不变。
- Rework 记下的 `conflict` / `known-gap` 不经 Spec 轴裁定，直接作为待人定的事列进验收包，因为人马上就会看。
- 有人审意见的需求永不自动合并。托管上的汇总评论是 bot（或 GitLab 上令牌本人）写的，不算进 `humanComments`，否决靠平台自己的记录。
- 导读只用平台已有的记录（运行的 summary、决定、验收标准、Finding、逐行归属）拼出，不为它跑 agent：解释来自当时做这件事的 agent，位置来自 git，都可以核对。
- 放弃的方案：意见以托管为准（要个人身份和逐条同步，单人使用时收益小）；意见自动生成追加票（要多一种写票的 agent 运行，小意见也要跑完整个票流水线和重新收尾）；修改要求重跑 final-review（等于第二次审查）；用 LLM 生成导读（多一次花钱的运行，要校验它说的位置是否存在，解释也不比当时的 agent 更可信）。

**design.md 改动**（已写入）：

- 「平台与代码托管的分工」表：平台「内容」加人审意见和修改要求，「能看到」加各 PR 的代码差异和导读，「能操作」加写人审意见、提交修改要求；托管侧「内容」的「人写的 review 评论」改成「人直接在托管上写的评论」。
- 原「PR 上人写的评论可以拉回来返工」那段改成本方案：意见在平台写，分支名是 `agent/<id>/S-<n>-rework-<k>`（推送出口只允许 `agent/*`、`spec/*`），状态走 finalizing 而不是 reworking。
- 需求状态图加 `awaiting-review → finalizing：提交修改要求`、`finalizing → merged：返工中人合并了 PR`。
- 「以后」列表里删掉「PR 评论返工」。

## 3. 审查版本：diff 从哪来

**由 worker 用 git 算，托管只提供 SHA。** 托管的 diff 接口有截断（GitHub 每个 PR 的文件列表和 patch 都有上限），GitHub 和 GitLab 的格式也不同。worker 的主 clone 里本来就有默认分支和 `spec/*`，`open-pr`、`index-pr-links` 也是这样用主 clone 的（`packages/worker/src/worker.ts:335-370`）。PR 页面显示的就是 `merge-base(默认分支, head)..head`，git 算出来的和它一致。

新增托管任务 `review-revision`（`HostTask` 加一种，`packages/api/src/host/pull-requests.ts:60`）：

```ts
{
  kind: "review-revision";
  pullId: number;
  repoUrl: string;
  repoName: string;
  defaultBranch: string;
  headSha: string; // pull_requests.head_sha，host-sync 最近一次读到的
  previousHeadSha: string | null; // 人上次审的版本，见 3.4
}
```

生成文件名单不放在任务上：worker 在 `headSha` 上自己 `readGateConfig(repoDir, headSha)`，和现有门禁同一条路。

worker 的做法：

1. `repos.ensure(repoName, repoUrl, defaultBranch)`，再 `fetchObject(headSha)`，确保 head 在本地，即使 `spec/*` 已经又前进了。生成文件名单用 `readGateConfig(repoDir, headSha)` 的 `generated`，不从任务参数带。
2. `mergeBase = git merge-base origin/<default> <headSha>`，记下当时的默认分支 SHA 作为 `baseSha`。
3. `git -c diff.external= diff --no-ext-diff --no-textconv -M --raw -z --numstat mergeBase headSha` 得到文件清单（状态、改名、权限、增删行数、新旧 blob），再按文件取 patch。不读人的工作区，不执行仓库里的任何东西。
4. **文件级归属**：`git log --format=%H%x00%B%x00 --name-only mergeBase..headSha`，用 `parseTrailers` 读每个提交的 `Ticket:`、`Run:` trailer，累加到它改过的文件上。`links` 表要等 PR 合并后由 `index-pr-links` 写入，PR 还开着时用不上，所以这里现算。没有 `Ticket:` 的提交按 `Run:` 交给 API 查阶段（收尾修复、Tidy、Rework、Update-branch），两样都没有的是设置提交或规划提交。
5. **逐行归属**：对每个有新增行的文本文件跑 `git blame --porcelain mergeBase..headSha -- <path>`（`mergeBase` 之前的行算「原有」），得到每个新增行来自哪个提交，再按第 4 步的 trailer 归到票或阶段。每个 hunk 记下它包含哪些归属和各自的行数。删除行没有 blame，归到同一 hunk 里新增行的归属；纯删除的 hunk 用 `git log -L` 太贵，归到改过这个文件、且只有一个归属时的那一个，否则标「未知」。
6. 有 `previousHeadSha` 时，再对当前清单里 blob 变了的文件算 `git diff previousHeadSha headSha -- <path>`，作为「上次审后」的 patch。
7. **文件内容**：清单里每个文本文件的新旧两个 blob，各自不超过 512 KiB 的，内容一起交回，供展开上下文用（3.3）。
8. 上限：单文件 patch 256 KiB，整份 patch 4 MiB，文件 3000 个，逐行归属只对前 300 个文件做，blob 内容整份 16 MiB。超了的文件只给清单和行数，标 `patch: "omitted"` 和原因（`too-large`、`binary`、`over-total`）；文件数超了标整份 `partial`；没做逐行归属的文件退回文件级归属，页面上注明。上限放在 `packages/shared` 的常量里，API 的结果 schema 也按它校验。

结果 `ReviewRevisionResultSchema` 由 API 写入下面几张表。作业键按 `open-pr` 的办法带序号：`pull-{id}:review-revision:{headSha}:{seq}`。同一个 head 已经 `ready` 就不再排；`failed` 时下一次 GET 或进入 awaiting-review 的预先排会再排一记，写回同一行审查版本。结果超过 API 单次请求的大小时，worker 分块交回（按文件分批，最后一块带完成标记），API 收齐才算这个版本 `ready`。

### 3.1 表

```
review_revisions
  id, pull_request_id → pull_requests, head_sha, base_sha, merge_base_sha,
  previous_head_sha (nullable), state ('pending' | 'ready' | 'failed'), error (nullable),
  complete boolean, omitted_reason (nullable),
  files_count, additions, deletions, created_at, ready_at
  unique (pull_request_id, head_sha)

review_files
  id, revision_id → review_revisions, path, old_path (nullable),
  status ('added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'mode'),
  old_blob, new_blob, additions, deletions, binary boolean, generated boolean,
  patch text (nullable), patch_omitted (nullable: 'too-large' | 'binary' | 'over-total'),
  since_patch text (nullable),        -- 3.4
  attributions jsonb,                 -- 文件级：[{ ticket: 'T-301' } | { run: 'R-88', stage: 'final-fix' } | { kind: 'setup' | 'planning' }]
  hunks jsonb,                        -- 逐行：[{ newStart, newLines, oldStart, oldLines, owners: [{ ...归属, lines }] }]，没做逐行归属时为 null
  unique (revision_id, path)

review_blobs
  sha primary key, content text, bytes, created_at   -- 按 git blob SHA 去重，跨版本、跨 PR 共用

review_file_views
  pull_request_id, path, new_blob, viewed_at
  primary key (pull_request_id, path)
```

`review_file_views` 按 blob 记，不按版本记：同一个文件在新版本里内容没变，「已看」继续有效；内容变了就失效。现在没有登录（M5），不记是谁看的。

保留期跟运行日志一样：需求 merged 或 cancelled 90 天后，删 `review_files` 的 `patch`、`since_patch`、`hunks`，以及不再被别的审查版本引用的 `review_blobs`；清单、意见和修改要求留着（追溯用）。

### 3.2 什么时候算

- 页面或待审列表需要某个 PR 的审查版本，而这个 head 还没有 `ready` 的审查版本时，API 排 `review-revision`，先返回 `pending`（已有 `failed` 则再排一记）。worker 交回结果后，按 ADR 0008 由触发器写一条事件，页面经 SSE 失效查询、自动刷新。
- 需求进入 awaiting-review 时（第一次开 PR，或返工结束）就预先排一次，人打开时通常已经算好。
- 人正看着时 host-sync 发现 head 变了，页面只显示横幅「PR 有新提交：切换到 `e4f5a6b`」，不自动替换内容和行号。
- 不为所有 PR 定时算 diff。

### 3.3 展开上下文

hunk 上下各有「展开 20 行」和「展开到下一个 hunk」，文件末尾有「展开全部」。内容从 `review_blobs` 按行切给页面（`GET /review-blobs/{sha}?from=&to=`），不再排 worker 作业。blob 超过 512 KiB 没有存的文件，不显示展开按钮，写明「文件太大，到托管上看全文」。删除文件只能展开旧侧，新增文件只能展开新侧。

### 3.4 「上次审后」

「上次审的版本」= 这个 PR 最近一个有「已看」标记或人审意见的审查版本。API 排 `review-revision` 时把它的 head 作为 `previousHeadSha` 传下去。中间合进来过默认分支（update-branch）时，`since_patch` 里会混进默认分支对同一文件的改动，页面在「上次审后」视图顶部注明这一点。不在 PR 文件清单里的文件不算。

## 4. 审查页

路由 `/specs/$specId/review`（`packages/web/src/routes/specs/$specId/review.tsx`），search 参数 `pr`（平台的 PR id，API 校验属于这个需求）、`file`、`view=guide|all|since`、`q`（文件过滤）。需求有 PR 时，需求页的标签栏多一个「审查」，默认打开导读（第 5 节）；交付页每个 PR 卡片加「审查代码」，原来的托管链接保留。

- **顶栏**：PR 选择（按合并顺序）、审查版本的 head SHA、「已看 x/y」、视图切换（导读 / 全部变更 / 上次审后）、修改要求按钮（有草稿时显示数量）。PR 的 head 比当前版本新时显示切换横幅。
- **左栏**：文件树，分组可选「目录」或「票」。按票分组时一个文件可以出现在几张票下面；有逐行归属时，点某张票下的文件，diff 只高亮这张票的 hunk，其余 hunk 折叠成一行「另有 2 段属于 T-302」。文件上标增删行数、已看、有意见。
- **搜索和过滤**：树上方一个输入框（快捷键 `/`），按路径子串过滤，支持 `*` 通配。旁边的过滤器可以多选：未看、有意见、有草稿、上次审后改过、新增 / 删除 / 改名、属于某张票、只看测试文件、隐藏生成文件。过滤条件写进 URL 的 `q`，刷新和分享后还在。过滤后「已看 x/y」仍按全部文件算，旁边另写「当前显示 n 个」。
- **中间**：每个文件一个可折叠块，unified diff，行号可以点，hunk 可以展开上下文（3.3）。`generated` 路径和常见 lockfile 默认折叠，显示行数，测试文件不折叠（门禁要看它们）。`patch_omitted` 的文件写明原因，给托管链接。审查版本 `complete = false` 时顶部写明「这份 diff 不完整」，「已看 x/y」不能显示成全部看完。
- **右栏**，三个标签：
  - **合并前清单**：直接读验收包已有的数据：`needsDecision`（待人定的决定、没做掉的 deferred、host-check）、未验证的验收标准、CI 和冲突状态、合并顺序、自动合并预告（`autoMergeLine`）。下面是本 PR 的人审意见，按状态分组。
  - **需求与票**：需求的 User Story；当前文件（或左栏选中的票）涉及的票，每张票的标题、负责的 User Story、验收标准和它们的验证状态（`verified` / `unverified` 和原因）、链接到票页。数据来自验收包 `repos[].tickets` 和需求正文。
  - **Finding**：当前文件涉及的票和收尾的 Finding，带轴、阶段和处理结果，还有范围外改动（`scopeCreep`）和审查疑点。数据来自验收包。Finding 没有文件和行号，这里按票关联，不挂到行上。
- **diff 渲染**：web 已经依赖 `diff@9`，用它的 `parsePatch` 解析，自己写一个只读的 renderer 组件，大文件按 hunk 懒渲染，长文件列表虚拟滚动。这一次不做语法高亮和并排对照。
- **快捷键**沿用 `shortcuts.ts`：`j`/`k` 上下一个文件，`n`/`p` 上下一个 hunk，`v` 切已看，`/` 搜索，`c` 在当前行写意见。

## 5. 导读

导读挂在审查版本上（`GET /review-revisions/{id}/guide`），由 API 用库里已有的记录和这个版本的逐行归属拼出来，结果按版本缓存。版本变了导读就跟着重算，不会把旧导读配到新代码上。

**章节顺序**：

1. **需求在做什么**：需求标题、类型、User Story 列表，以及 bug 需求指向的原需求。
2. **每张票一节**，按依赖边（`edges`，契约边和阻塞边都算）拓扑排序，同层按票号；追加的票标「追加」。每节写：
   - 票标题、负责的 User Story（`stories`）、验收标准和验证状态；
   - agent 怎么做的：这张票每次改代码的运行（implement、gate-fix、review-fix、merge-fix）结果里的 `summary`，按时间排，最后一次在最前；
   - 它记下的决定（`choice`、`conflict`、`known-gap`、`deferred`、`workaround`）和 Spec 轴的裁定；
   - 这张票在本仓库的 hunk 清单：文件、行范围、行数，点一下跳到「全部变更」里那个 hunk；
   - 本节进度：这些 hunk 所在的文件都标了已看，本节就算看完。
3. **收尾的改动**：final-fix、Tidy、Update-branch 各一节，用它们运行的 `summary` 和对应的整体审查意见。
4. **每次修改要求一节**：意见原文、Rework 的逐条处理结果、Rework 改的 hunk。
5. **设置和规划提交**：Setup commit 和 Planning commit 改了什么（通常是门禁、规范、GLOSSARY、ADR）。
6. **没有归属的改动**：逐行归属是「未知」或没做逐行归属的 hunk，按文件列出。这一节不为空时，导读顶部写明「有 n 段改动没能对到票」。

多仓库需求每个 PR 各有一份导读，第 1 节相同，第 2 节只列在本仓库有改动的票，另注明「T-305 改的是 frontend 仓库」并给出跳转。

导读只用平台已有的记录，不为它跑 agent。`summary` 是当时做这件事的 agent 写的，一次运行没有 summary（失败或没有输出）就不列，不补写。

## 6. 待审列表

顶栏新增「待审」（`/review`），和「待处理」（`/waiting`，blocked 的票和收尾）分开。列出所有项目里下面四组需求，每组内按风险排序：

| 组         | 条件                                                                                                                       |
| ---------- | -------------------------------------------------------------------------------------------------------------------------- |
| 等你审     | awaiting-review，当前审查版本上一个文件都没看过，也没有草稿                                                                |
| 审到一半   | awaiting-review，看过一部分或有草稿；或返工结束后有文件「上次审后改过」还没看                                              |
| 返工中     | finalizing，且有 active 的修改要求；或 reworking（追加票返工）                                                             |
| 看完待合并 | awaiting-review 或 partially-merged，所有 PR 当前版本的文件都看过、没有草稿；partially-merged 也放在这里（还有 PR 没合并） |

每行显示：需求编号和标题、项目、类型、仓库和 PR 数、在这一组里等了多久（从进入 awaiting-review 或返工结束算起）、改动行数、已看进度、CI 和冲突、自动合并预告，以及风险标签。点行进入那个需求的审查页（默认导读）。

**风险排序**：每个需求按下面的条件依次比较（前一条相同才看后一条），并把命中的条件显示成标签，不算一个看不出来源的总分：

1. 有待人定的决定（`needs-human`）或没被处理的人审意见（`declined`）
2. CI 失败、和默认分支冲突、合并顺序被打破
3. 有未验证的验收标准、没做掉的 `deferred`、`host-check`
4. 门禁批准过的保护路径改动或删除测试
5. 多仓库或有契约边
6. 改动行数（多的在前）
7. 等的时间（久的在前）

接口 `GET /review-queue?project=`，由 API 一次查出，验收包和审查版本都只读不算。还没有审查版本的需求，进度显示「未计算」，并顺带排一次 `review-revision`（3.2）。

## 7. 人审意见

```
review_comments
  id, spec_id → specs, pull_request_id → pull_requests, revision_id → review_revisions,
  path (nullable: null 表示挂在 PR 上), side ('old' | 'new', nullable), line_start, line_end (nullable),
  excerpt text (nullable)       -- 写意见时那几行代码，存下来，不靠以后重新定位
  body text (1..4000 字),
  state ('draft' | 'submitted' | 'addressed' | 'declined'),
  change_request_id → change_requests (nullable，draft 时为空),
  reply text (nullable)         -- Rework 对这条的交代
  rework_run_id → runs (nullable), created_at, updated_at
```

- 只在需求 awaiting-review 时能写、改、删草稿，其他状态只读。需求 cancelled 时删掉草稿；已经提交的意见留下。
- 意见永远显示在它写下时的审查版本上，带 `excerpt`。新版本里不重新定位，只在列表里标「写于 `a1b2c3d`」。
- `addressed` 只表示 Rework 说处理了、门禁通过、已经合回，不表示人确认过；人不满意就再写一条。和 Finding 的 `fixed` 是同一种保证程度。
- 显示编号 `C-<n>`（`formatDisplayId` 加一种），Rework 的上下文、汇总评论和导读都用它。

## 8. 修改要求与 Rework

### 8.1 提交

`POST /specs/{id}/change-requests`，在一个事务里、锁住需求：

1. 需求必须是 awaiting-review，至少有一条草稿，草稿所属的 PR 都是 open。不满足就拒绝（409），写明原因：
   - partially-merged：「已有 PR 合并，不能再提交修改要求。还要改的部分，请在规划机器上建一个指向 S-70 的 bug 需求。」（bug 需求可以指向原需求，GLOSSARY「Spec」），同一句话也显示在审查页的提交按钮旁边。
   - finalizing、reworking：「正在返工，等它结束再提交。」
   - 其他状态：「需求不在等人验收。」
2. **旧版本上的草稿**：有草稿写在不是 PR 当前 head 的审查版本上时，请求里没有 `acknowledgeStale: true` 就返回 409，带上这些草稿的编号、写于哪个版本、当前是哪个版本。页面据此弹确认框「3 条意见写在 `a1b2c3d` 上，PR 现在是 `e4f5a6b`；agent 会看到意见写下时的那几行代码。仍然提交？」。确认后照常提交，这些意见在 Rework 上下文里带 `writtenOn`。
3. 新建 `change_requests`（`id, spec_id, number, created_at, state ('active' | 'done' | 'superseded')`），本需求的草稿全部改成 `submitted` 并挂上它。
4. 需求按新事件 `request-changes` 从 awaiting-review 进入 finalizing（`spec-state.ts` 加事件和转移）。事件原因记「提交修改要求 C-1…C-3」，算人的操作（`recordAction`）。
5. 有意见的仓库，把它的 finalization 行改成 `step = 'rework', state = 'active'`，清掉 `blocked_reason`、`auto_retried`、`retry_note`，`job_floor` 取当前最大作业号，然后排 `rework` 作业。没有意见的仓库，finalization 保持 done。
6. 作废这个需求的 `final_e2e` 行（删或重置）。在 awaiting-review 追加时同样作废。否则第一次收尾留下的 `done`/`waived` 会让第二次收尾跳过「分支被改过再跑 e2e」。
7. 停掉这个需求的自动合并作业（`stopAutoMergeJobs`，原因「提交了修改要求」），所有 open 的 PR 排 `pr-draft`。和追加票的做法一样（`planning.ts:665-681`）。
8. 排一次 `review-note`（8.6），在 PR 上写汇总评论。

同一个修改要求重复提交（双击、重试）：第二次时需求已经不是 awaiting-review，按第 1 步拒绝，不会建出两次。

### 8.2 收尾流程加一步

`FINAL_STEPS` 加 `rework`（`packages/shared/src/finalize-flow.ts`），`advanceFinalization` 的规则：

| 报告                            | 决定                                                                                                                                                                                                                 |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `rework` done                   | 排 `final-merge`；命中 Recheck 触发条件、SHA 又不在 `allowed_recheck_shas` 里时先排 `recheck`                                                                                                                        |
| `rework` 没有结果或超时         | 和 final-fix 一样，自动重试一次                                                                                                                                                                                      |
| `rework` cannot-proceed         | blocked，原因照 final-fix                                                                                                                                                                                            |
| 之后的 `recheck`、`final-merge` | `rework` 这条路上 `final-merge` merged 之后结束，不进 Tidy。后继写死为 done，即使 `tidyWantedOf` 仍为真也不排 `final-tidy`（修改要求没有新的 Standards 建议；只靠「曾经跑过 Tidy」挡不住第一次收尾没跑 Tidy 的仓库） |

`recordFinalResult`（`packages/api/src/finalize/finalize.ts:103`）里，只对 `final-fix` 判 Recheck 触发的那段，扩展到 `rework`。`settleFinalization`（`packages/api/src/finalize/final-e2e.ts:151`）里「收尾改过分支，联调票要再跑 e2e」的查询加上 `stage = 'rework' AND result = 'done'`。只加这一句不够：今天 `final_e2e` 每需求一行，第一次收尾已经 `done`/`waived` 时后面不再看「分支被改过」。提交修改要求、以及在 awaiting-review 追加时，都作废（删或重置）这行，让检查重新生效。全部仓库 done 后走已有的 `finishOpeningWithExistingPulls`（`pull-requests.ts:241`）：重建验收包，更新 PR 描述、按合并顺序把 PR 转回 ready，需求回到 awaiting-review。

流程收尾时把这次的 `change_requests` 标成 done。Rework 进行中需求不是 awaiting-review，写不了新草稿，所以同一时刻最多一次 active 的修改要求。

### 8.3 返工中人合并了 PR

现在需求在 reworking 时人合并了 PR，`finishReworkingBecausePrMerged` 会把需求标成 merged、取消没做完的票（`pull-requests.ts:823-907`）。但需求在 finalizing 时合并了 PR，`markMergedWhenAllAre` 直接返回，什么都不做。追加票返工后的第二次收尾也有这个漏洞，Rework 只会更常遇到它。

改成：finalizing 且这个需求已经有 PR 时（也就是返工后的收尾，两种返工都算），任何一个 PR 被合并，都按「返工中人合并了 PR」处理：需求进入 merged（状态机加 `finalizing → merged：all-prs-merged`），停掉它所有收尾作业并关闭它们的 Run，active 的修改要求标 superseded、它的意见留在 submitted，然后排清理。和 reworking 时的行为一致。

### 8.4 Rework 运行

**分支**：`branchNames` 加 `rework(specDisplayId, k)`，得到 `agent/<id>/S-<n>-rework-<k>`，`k` 是修改要求的编号。`branches.ts` 的 `TICKET` 正则加上 `rework-[1-9][0-9]*`，`isPlatformBranch` 和清理就会认它；`spec-cleanup` 要删的分支列表（`pull-requests.ts:552` 附近）加上这个需求所有修改要求的 rework 分支。每次修改要求都用新名字，不复用旧分支，避免 `agentChange` 把已经合回的旧提交当成要救回的工作。

**worker**：`agentChange`（`packages/worker/src/stages/implement.ts`）的阶段列表和 `RECHECK_TRIGGER_STAGES` 加 `rework`，其余和 final-fix 相同：从集成分支切出、跑 agent、补 trailer、推送、交回。保护路径和 final-fix 一样：项目保护路径生效，`allowedProtectedPaths` 为空（没有票级豁免）。按 agent 运行计入工期。意见要求改保护路径或删测试名时，Rework `cannot-proceed` 或 `declined`+`conflict`，人用追加票并批准。

**bundle**：`packages/api/src/stages/bundle.ts` 里收尾那支（约 640-730 行）加 `rework`：`agentBranch` 用上面的名字，`review` 换成这次修改要求里本仓库的意见，worker 渲染成 `/context/review-comments.json`：

```json
{
  "changeRequest": 2,
  "currentHead": "e4f5a6b…",
  "comments": [
    {
      "id": "C-12",
      "writtenOn": "a1b2c3d…",
      "path": "src/orders/list.ts",
      "side": "new",
      "lines": [41, 44],
      "excerpt": "…写意见时的那几行…",
      "body": "这里空列表要返回 200 和 []，不是 404"
    },
    {
      "id": "C-14",
      "writtenOn": "e4f5a6b…",
      "path": null,
      "body": "迁移脚本要能重复跑"
    }
  ]
}
```

**提示词**：新增 `packages/pipeline/prompts/rework.md`，`agent.ts` 的提示词表和阶段列表加 `rework`。要点：

- 读 `/context/review-comments.json`、`spec.md`、`tickets.md`、`run.json`、`AGENTS.md`。每条意见都要处理，只改意见需要的地方；票的验收标准改完后必须还成立。
- `writtenOn` 和 `currentHead` 不同的意见，先在当前代码里找到 `excerpt` 对应的位置；找不到、或者那段代码已经变得意见不再适用，就写成 `declined` 并说明。
- 意见改变行为的，按 tdd skill 先写会失败的测试；只是命名、注释、文档的，不必硬写测试。
- 意见和需求、契约或现有测试冲突的，不改，写成 `declined` 并说明原因，同时写一条 `conflict` 决定。
- 结果：

```
<result>
{
  "status": "done",
  "summary": "一两句话",
  "comments": [
    { "id": "C-12", "outcome": "addressed", "reply": "空列表返回 200 和 []，加了测试 list returns empty array" },
    { "id": "C-14", "outcome": "declined", "reply": "迁移已经用 IF NOT EXISTS，重复跑不会出错；没有改" }
  ],
  "acceptance": {},
  "decisions": []
}
</result>
```

`comments` 必须正好覆盖上下文里的每个 id，缺了、多了或 id 不认识，都按 `invalid-output` 处理（走已有的结果格式修复）。`FinalResultSchema` 加 `rework`，outcome 和 final-fix 相同，外加 `comments`。

**结果落库**：`rework` done 时，按 `comments` 把意见改成 `addressed` / `declined`，写 `reply` 和 `rework_run_id`。门禁或合并失败需求 blocked 的，意见保持 `submitted`。决定日志照常写，`conflict` / `known-gap` 不经裁定，直接进验收包的 `needsDecision`（ADR 0012）。

**其他要加 `rework` 的阶段列表**：`links/record.ts`（`final-merge` 的来源阶段）、`acceptance/pack.ts:751`（审查后改动）、`tickets/timeline.ts`、`tickets/views.ts:781`、`shared/lead-time.ts`（按 agent 段计）、需求页的收尾进度组件、导读的第 4 节。

### 8.5 验收包和 PR 描述

`AcceptancePack.repos[]` 加 `reviewComments`：本仓库所有已提交的人审意见，带编号、修改要求编号、位置、原文、状态和 reply。`pack-description.ts` 在仓库那一节放到最前面：「人审意见：3 条已处理，1 条没处理（C-14：原因）」，展开是逐条明细。没处理的那几条同时进 `needsDecision`，人合并时就会看到。

### 8.6 PR 上的汇总评论

新增托管任务 `review-note`，`HostAdapter` 加一个方法：

```ts
// Creates or updates the one comment the platform keeps on this pull request for review notes. It is found by
// marker among the token user's own comments, so a lost response does not leave two.
upsertPlatformComment(input: { repo: RepoRef; number: number; marker: string; body: string }): Promise<{ id: string }>;
```

GitHub 用 issue comments 接口，GitLab 用 MR notes 接口。标记是 `<!-- afk:review-notes -->`，一个 PR 一条。提交修改要求时写入意见清单（标「处理中」），Rework 结束后改成逐条结果。失败隔 60 秒重试，三次为止；不挡流程，审查页显示「PR 上的汇总评论没写上」和原因。GitHub App 现有权限是 Pull requests 写，实现时要在演练仓库确认它够写 PR 评论；不够时停下来交给人决定加权限，不改成别的写法。

### 8.7 自动合并

- `AutoMergeInput` 加 `reviewComments: number`（这个需求已提交的人审意见数），`autoMergeForecast` 在 `humanComments` 判断后面加一条：大于 0 时 `fail("平台上有人审意见")`。和「PR 上有人写过评论」一样，以后也不再自动合并。
- 提交修改要求时停掉自动合并作业（8.1 第 6 步），这和追加票是同一个调用。

## 9. 两处小修

1. **交付页文案**：`packages/web/src/spec-detail/delivery.tsx:83` 的「按这个顺序合并；平台从不合入。」改成按项目合并策略显示：`manual` 时「按这个顺序合并，平台不会合并」；`auto-improvement` 时「按这个顺序合并；满足条件时平台会自动合并」，后面接已有的 `autoMergeLine`。
2. **自动合并前重读 PR**：worker 的 `auto-merge`（`packages/worker/src/host.ts:239`）改描述之前先 `getPullRequest`：已经不是 open、成了草稿、head 不是 `expectedHeadSha`、`humanComments > 0`、`review` 是 `changes-requested`，任何一条成立就按失败返回（原因写清楚），不改描述，也不合并。现在只靠上一次 host-sync 的结果，最多有约一分钟的空档。这只影响开了 `auto-improvement` 的项目（目前只有 GitHub 上的平台自己）。GitLab 上 `humanComments` 不算令牌本人，而项目用的是人自己的 PAT，所以人在 MR 上写的评论在 GitLab 上不计数。现在 GitLab 不自动合并，没有后果，在这里记下。

## 10. 接口

都按 `packages/api/src/http/*` 的 `createRoute` 写，`pnpm gen:api` 更新 OpenAPI 和客户端。

| 方法和路径                                               | 作用                                                                                                                                         |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /review-queue?project=`                             | 待审列表（第 6 节）                                                                                                                          |
| `GET /specs/{id}/review`                                 | 本需求每个 PR：当前 head、审查版本状态（`ready` / `pending` / `failed`）、已看数、意见数；合并前清单；需求与票、Finding 的数据；修改要求历史 |
| `GET /pull-requests/{id}/review-revision?head=<sha>`     | 审查版本的文件清单、文件级和逐行归属、已看状态；缺了就排 `review-revision`，返回 `pending`                                                   |
| `GET /review-revisions/{id}/guide`                       | 导读（第 5 节）                                                                                                                              |
| `GET /review-files/{id}?view=all\|since`                 | 一个文件的 patch 或「上次审后」的 patch                                                                                                      |
| `GET /review-blobs/{sha}?from=&to=`                      | 展开上下文用的行（3.3），只返回属于本平台某个审查版本的 blob                                                                                 |
| `PUT` / `DELETE /pull-requests/{id}/viewed-files/{path}` | 标已看、取消已看（带 `newBlob`）                                                                                                             |
| `POST /pull-requests/{id}/review-comments`               | 写草稿（版本、位置、excerpt、正文）                                                                                                          |
| `PATCH` / `DELETE /review-comments/{id}`                 | 改、删草稿                                                                                                                                   |
| `POST /specs/{id}/change-requests`                       | 提交修改要求（8.1），可带 `acknowledgeStale`                                                                                                 |

`plat spec show` 加一行：人审意见 `n` 条（待处理 / 已处理 / 没处理），最近一次修改要求的状态。`plat` 不加待审列表命令，待审只在页面上看。

## 11. 性能目标

下面是要实测的目标，不是已经达到的指标。实现时在 Mac 上用一个典型 PR（约 30 个文件、1000 行改动）和一个大 PR（约 300 个文件、2 万行）各量一次，把冷启动、worker 排队、git 计算、传输、渲染分开记，结果写回本文档：

| 场景                                               | 目标                           |
| -------------------------------------------------- | ------------------------------ |
| 审查版本已算好，打开审查页到文件树和第一个文件出来 | 1 秒内                         |
| 已加载的版本里切换文件、展开上下文                 | 200ms 内                       |
| 待审列表打开                                       | 1 秒内（20 个需求以内）        |
| 导读打开（版本已算好）                             | 1 秒内                         |
| `review-revision` 在 worker 上的计算（不含排队）   | 典型 PR 10 秒内，大 PR 60 秒内 |

托管任务和 agent 运行共用 worker 的领取循环：循环数等于沙箱槽位数（`packages/worker/src/worker.ts:172`），每个循环一次只做一个作业。槽位全被 agent 运行占着时，托管任务（现在的 host-sync 也一样）要等某个运行结束才有循环去领。`review-revision` 本身不占槽位（加进 `packages/shared/src/slotless-jobs.ts` 的列表），但人打开审查页时如果正好两个需求在跑，要等几十分钟，1 秒的目标就达不到。所以 T4 给 worker 多开一个循环，它只领不占槽位的作业（`claim(false)`），槽位满时托管任务和 `review-revision` 也有人领。实测时记下排队时间。

## 12. 为什么这些不做

- **在平台里合并**：要改 ADR 0011 的「只有一个出口」；GitLab 的 bot 是 Developer，合不了受保护分支。人审完点一下链接就能合，省下的时间很少。
- **以人的身份在托管上提交正式 Review**：要个人 OAuth、逐条同步和失败对账，是最复杂的一块。现在只有一个人用，GitHub 免费账号的私有仓库没有分支保护，批准没有约束力；平台只在自动合并时读 `changes-requested`。等有第二个审查人或分支保护时再做。
- **拉托管上评论的正文**：单人使用时托管上几乎没有别人的评论；页面显示托管上的评论数和链接。
- **意见自动生成追加票**：要新增一种写票的 agent 运行，一条小意见也要走完票的全部阶段再重新收尾。涉及新行为的意见，人用追加票更合适。
- **纯评论**（只留记录、不交给 agent）：现在提交的意见都会交给 Rework。要只留记录，可以不提交草稿。
- **并排对照、语法高亮、Finding 的文件和行号**：都是在这次的数据上加东西，不影响这次的表和流程。

## 13. 拆票

项目 4（afk-platform）一个需求，下面是建议的票和依赖。改 `schema.ts` 的票都要 `db:generate` 并提交 SQL；改路由的票都要 `pnpm gen:api`。

| 票              | 内容                                                                                                                                                                                                                                                                                                                                                     | 依赖        |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| T1 文档         | GLOSSARY 六个新词和两处补充、ADR 0012、design.md（grilling 已写入；实现时核对仍与共同理解一致）                                                                                                                                                                                                                                                          | —           |
| T2 交付页文案   | 第 9 节第 1 条                                                                                                                                                                                                                                                                                                                                           | —           |
| T3 合并前重读   | 第 9 节第 2 条                                                                                                                                                                                                                                                                                                                                           | —           |
| T4 审查版本     | `review_revisions` / `review_files` / `review_blobs` / `review_file_views` 表；`review-revision` 托管任务（shared 类型、api 排队和分块落库、worker 用 git 算 diff、文件级和逐行归属、blob 内容；生成文件从该 head 的 `gates.yaml` 读；失败按序号重排）；上限常量；进入 awaiting-review 时预先排；保留期；worker 多一个只领不占槽位作业的循环（第 11 节） | T1          |
| T5 审查接口     | 第 10 节里审查版本、文件、blob、已看、`/specs/{id}/review` 五个接口；事件和 SSE 刷新                                                                                                                                                                                                                                                                     | T4          |
| T6 审查页       | 路由、标签、文件树（目录 / 票）、逐票高亮 hunk、搜索和过滤、diff renderer、展开上下文、已看、切换横幅、右栏三个标签、「上次审后」视图、快捷键                                                                                                                                                                                                            | T5          |
| T7 导读         | 导读接口（拓扑排序、summary 和决定、hunk 清单、各节进度）和页面视图                                                                                                                                                                                                                                                                                      | T5、T6      |
| T8 待审列表     | 待审接口（分组、风险排序、标签）和 `/review` 页面、顶栏入口                                                                                                                                                                                                                                                                                              | T5          |
| T9 人审意见     | `review_comments` 表、草稿接口、页面上写和列意见                                                                                                                                                                                                                                                                                                         | T5、T6      |
| T10 修改要求    | `change_requests` 表、提交接口（含旧版本确认和拒绝说明）、`request-changes` 事件、收尾加 `rework` 步、finalizing 时合并 PR 的处理（8.3）、自动合并否决（8.7）                                                                                                                                                                                            | T9          |
| T11 Rework 运行 | 分支名、bundle 和 `/context/review-comments.json`、`rework.md`、结果 schema、worker 阶段、Recheck 触发、意见落库、各阶段列表                                                                                                                                                                                                                             | T10         |
| T12 验收包和 PR | 验收包「人审意见」、PR 描述、`upsertPlatformComment`（GitHub / GitLab）和 `review-note` 任务、页面显示结果、导读第 4 节、待审列表「返工中」、`plat spec show`                                                                                                                                                                                            | T11、T7、T8 |
| T13 演练和测量  | 第 14 节末尾的两次演练、第 11 节的测量，结果写回本文档                                                                                                                                                                                                                                                                                                   | T12         |

## 14. 验收

新行为先通过公共接口写红测试：API 测试连真 Postgres，GitHub / GitLab HTTP 和 agent 运行器用边界假对象，git 用临时仓库真跑。

**审查版本**

- 一个有改名、删除、二进制、权限变化、无换行结尾、超大文件的临时仓库，`review-revision` 交回的清单和 `git diff --raw` 一致；超上限的文件标对原因，整份超上限时 `complete = false`，页面不显示「全部看完」。
- 同一个 head 已经 `ready` 时打开两次只排一次作业；`failed` 时再打开会再排一记，写回同一行；head 变了才排新版本；进入 awaiting-review 时预先排了一次。
- 文件级归属：带 `Ticket:` 的提交归到票，只有 `Run:` 的按阶段归，两样都没有的归设置或规划；一个文件被两张票改过时两张票下都有它。
- 逐行归属：同一文件里两张票各加的行分到各自的 hunk 归属里；`mergeBase` 之前就有的行不算；超过 300 个文件后的文件退回文件级归属并标明。
- 文件内容没变时「已看」跨版本保留，内容变了失效。
- 展开上下文返回的行和 blob 内容一致；超过 512 KiB 的文件没有展开；不属于任何审查版本的 blob SHA 返回 404。
- 仓库里配了 `diff.external` 和 textconv 时，worker 也不执行它们。
- worker 的槽位全被 agent 运行占着时，`review-revision` 和 host-sync 仍能被领走并完成。

**页面**

- 搜索和每种过滤都能单独和组合使用，条件留在 URL 里；过滤后「已看 x/y」仍按全部文件算。
- 按票分组时只高亮这张票的 hunk；右栏「需求与票」和「Finding」随当前文件或选中的票变化。

**导读**

- 票按依赖边拓扑排序，同层按票号；追加的票有标记。
- 每节列出这张票各次改代码运行的 summary 和决定；没有 summary 的运行不列；hunk 清单和逐行归属一致，点击跳到对应 hunk。
- 有没能对到票的改动时，最后一节列出它们，顶部有提示。
- 多仓库需求的导读只列在本仓库有改动的票，并注明别的仓库。
- 版本变了，导读按新版本重算。

**待审列表**

- 四组的划分符合第 6 节的条件，包括 reworking（追加票返工）也在「返工中」、partially-merged 在「看完待合并」。
- 风险排序按第 6 节的条件依次比较，标签和命中的条件一致。
- 没有审查版本的需求显示「未计算」，并排了一次计算。

**修改要求和 Rework**

- 只有 awaiting-review 能提交；partially-merged、返工中、其他状态、没有草稿、PR 不是 open 都拒绝，并给出第 8.1 节对应的说明（partially-merged 那条指向建 bug 需求）。
- 有草稿写在旧版本上时，没带 `acknowledgeStale` 返回 409 和明细；带了就照常提交，上下文里这些意见带 `writtenOn`。
- 提交后需求是 finalizing，只有有意见的仓库排了 rework，PR 排了转草稿，自动合并作业停了。重复提交不会建出第二个修改要求。
- Rework done → final-merge → 收尾结束：验收包有「人审意见」，PR 描述更新，PR 转回 ready，需求回到 awaiting-review，修改要求是 done，每条意见按结果是 addressed 或 declined。
- `comments` 缺 id、多 id 或 id 不认识时是 `invalid-output`。
- Rework 删改已有测试或改测试和构建配置时走 Recheck，和 final-fix 一样。
- 第二次修改要求用新的分支名，`spec-cleanup` 删掉所有 rework 分支。
- 联调需求里 Rework 改了分支，收尾结束前重跑 e2e（提交时作废了旧的 `final_e2e` 行，不是只改 SQL）。

**两条返工路都要成立的行为**（追加票之后的重新收尾，和修改要求的 Rework）：

- 返工中人在托管上合并了 PR，两条路下需求都进 merged，剩下的作业都停掉、Run 都关掉，并排清理。追加票这条路在 reworking 和之后的 finalizing 都要测。
- 返工结束后，两条路都重建验收包、更新 PR 描述、按合并顺序转回 ready，并预先排新版本的 `review-revision`。
- 两条路都作废旧的 `final_e2e` 行；联调需求第二次收尾会再跑 e2e。
- 两条路下自动合并都不会在返工中或返工后发生：追加票靠 reworking 和草稿，修改要求靠「平台上有人审意见」。
- 两条路下需求都出现在待审列表的「返工中」，结束后回到「审到一半」或「看完待合并」。

**自动合并**

- 有已提交的人审意见时，预告显示「平台上有人审意见」，不排作业。
- 合并前 PR 有了新评论、新提交，或者被转成草稿：worker 不改描述，也不合并，按失败返回。`guards.test.ts` 继续通过（合并调用只在那一个出口）。

**安全**

- 网页、作业参数和日志里都没有令牌；页面只能用属于这个需求的 PR id 和属于本平台审查版本的 blob；worker 不连数据库；agent 拿不到凭据，只读 `/context`。

**演练**（在 Mac 的 3000 端口平台上，各一次）：

1. **GitHub**：平台自己的仓库，一个 improvement 需求，两张有依赖的票。从待审列表进入，按导读看完，提交两条意见（一条能改，一条应该被 declined，其中一条写在旧版本上），看完整个流程。确认 PR 上的汇总评论、验收包、导读的「修改要求」一节、待审列表的分组和自动合并都对；确认 GitHub App 的现有权限能写 PR 评论。
2. **GitLab**：自建 GitLab CE 17.3.1 上的试点仓库，同样走一遍：MR 的审查版本和 GitLab 页面上的 diff 一致，MR 能转草稿和转回，MR notes 上的汇总评论能写、能更新、不重复。记下 GitLab 上 `humanComments` 不计令牌本人的行为。

两次演练都按第 11 节测量，结果写回本文档。

## 附：Linear 是怎么做的

参考的是 Linear 桌面端 1.32.8。它的 `app.asar` 只是外壳，审查界面是从网页加载的，本地浏览器缓存里有打包后的前端代码（`PullRequest*`、`Review*`、`Diff*` 等约 150 个模块）。用 REA 做了静态分析（Evidence `ev_8cb6299b6c09b9e9735d66b3d41a932146640a95b0ed89d64417b371a2f9dabe`，部分覆盖），下面的结论来自这些代码里的字面文案和字段名，没有运行它们。

| Linear                                                                                                                 | 这次借鉴到哪里                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Reviews 收件箱：请你审的、可以合并的、所有打开的；可以暂缓到有人评论或再次请你审                                       | 待审列表的四组（第 6 节）；不做暂缓，单人使用                              |
| Guide：把改动组织成带说明的章节，可以跳到代码                                                                          | 导读（第 5 节），说明来自平台已有的记录而不是新生成                        |
| 风险分级（Low 到 Very High）                                                                                           | 风险排序用看得到来源的标签，不给单一分数                                   |
| `All commits` / `Since last review` / `Latest agent changes`                                                           | 「上次审后」视图（3.4），导读的「修改要求」一节                            |
| 标文件已看，之后被改了提示 `Modified after review`；按文件类型分组、过滤未看和有评论的文件；生成文件、测试文件可以折叠 | `review_file_views` 按 blob 失效；搜索和过滤；生成文件折叠，测试文件不折叠 |
| 合并面板列出还差什么：修失败的检查、解决冲突、处理要求的修改、处理 agent 意见、解决讨论                                | 右栏合并前清单，数据用验收包                                               |
| 把未解决的评论复制成提示词、交给 agent                                                                                 | 修改要求和 Rework                                                          |
| AI 审查意见有类别、`canWait`（不挡合并）、`preExisting`、修过又被改回去（resurfaced）                                  | 这次不做；以后给 Finding 加位置时参考                                      |
| 用人的托管账号评论和回复                                                                                               | 这次不做（第 12 节）                                                       |
