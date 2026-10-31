# matt skills 对 tracker 的期待与平台冲突清单

研究票：#94（map #93「平台与 GitHub 的需求说明一字不差」）。调研日期 2026-10-31。

## 结论速览

- 七个 skill 里，**真正读 tracker 文档的是 to-spec、to-tickets、code-review、triage**（加上 implement 的一句"fetch it from the issue tracker"）。tdd 和 grill-with-docs 完全不碰 tracker：tdd 只读 `GLOSSARY.md` / ADR，grill-with-docs 只是转调 grilling 和 domain-modeling。
- 共找出 **15 条规划侧冲突**（tracker 文档要写清楚）和 **11 条执行侧冲突**（AFK 覆盖层要写清楚），见下面的两张表。**没有一条非 fork 不可**：skills 的说法要么本身就把"怎么做"交给 tracker 文档（"How depends on the tracker"、"unless instructed otherwise"、"a path the user passed as an argument"），要么是覆盖层可以直接改写的交互要求（"ask the user"、"confirm seams"）。
- 风险最高的两条：
  1. **P8**：to-tickets 原文写着"Do NOT close or modify any parent issue"，地图已定"to-tickets 结束时由 skill 执行 `plat spec confirm`"。tracker 文档可以把 confirm 定义为本 tracker 上"发布票"的最后一步，但这是唯一一处 tracker 文档和 skill 原文直接冲突的地方，要实测模型会听哪一边。
  2. **E1**：规划仓库里的 `docs/agents/issue-tracker.md` 会被 clone 进沙箱，implement 和 code-review 会照它去调 `plat`，可沙箱里没有 `plat`。覆盖层必须明确说"本次运行的 tracker 就是 `/context`"。
- **票正文"一字不差"做得到，但不能只靠覆盖层**：tracker 文档可以规定 `body` 存 issue-template 渲染后的原文，并且 `acceptance` 和正文里的 Acceptance criteria 逐字一致；但 `/context/ticket.md` 现在按平台自己的格式重新排版（P6），`plat spec show` / `plat ticket view` 的文本输出不打印正文（P3），页面也不显示正文。这几处要改平台代码。
- **Cursor CLI 无头模式按官方文档能跑并行子 agent**：2026 年 3 月 changelog 写明"interactive, headless, and editor sessions"都支持；v2026.08.11 起无头运行会等子 agent 跑完再退出。平台固定的 CLI 版本 `2026.10.22-27dcf5f` 晚于这两条。不过 Task 工具是否注入由服务端按账号和团队设置决定，论坛上有过 CLI 里缺 Task 工具的报告，我们的沙箱里还**没有实测**。建议 code-review 的两轴由平台**拆成两次独立的 review 运行**，结果由 worker 用代码汇总（第 6 节的方案 C）；skill 内部开子 agent 的方案 A 实测稳定后可以作为可选项。

## 1. 来源与版本

- mattpocock/skills 固定 commit `59db609eb1e18aaf59b63284d0e52255aff0c63c`（2026-10-27，"Close blank issues and route requests by kind (#1169)"）。本地 `/root/workspace/skills` 的 HEAD 是更早的 `5beb35b`，和固定 SHA 相比，`setup-matt-pocock-skills/` 下有 3 个文件不同。本文所有引文都用 `git show 59db609…:<path>` 从**固定 SHA** 读出，不来自工作区。
- 平台侧来源：`docs/agents/templates/pilot-issue-tracker.md`、`docs/design.md`「Agent 与 skills 对接」「`plat` CLI 与票的导入」、`docs/operations-manual.md`、`GLOSSARY.md`、`packages/pipeline/prompts/*.md`、`packages/pipeline/src/context.ts`、`packages/cli/src/index.ts` 和 `format.ts`、`packages/shared/src/ticket-import.ts`、`packages/api/src/tickets/views.ts`、`packages/worker/src/executor.ts`、`.sandcastle/Dockerfile`。
- Cursor 侧：官方文档 `cursor.com/docs/context/subagents`、`/docs/context/skills`、`/docs/cli/headless`，以及 `cursor.com/docs/cli/changelog`（2026-10-31 抓取原文后 grep 核对过引文），另有三个论坛帖。Sandcastle 0.12.0 的 cursor provider 读的是本机 `node_modules/@ai-hero/sandcastle/dist/index.js`。

## 2. 每个 skill 在哪里读 tracker、期待什么操作

| skill | 读 tracker 的位置（固定 SHA 原文） | 期待的操作 |
| --- | --- | --- |
| **to-spec** | 第 9 行："The issue tracker and triage label vocabulary should have been provided to you. If not, tell the user to run `/setup-matt-pocock-skills`."；第 19 行："Write the spec using the template below, then publish it to the project issue tracker. Apply the `ready-for-agent` triage label - no need for additional triage." | **建 issue**（发布 spec）、**打标签**（`ready-for-agent`，要经 triage-labels 映射）。第 15–17 行要和用户确认 seams，但模板里没有专门的 seams 一节。 |
| **to-tickets** | 第 11 行同上；第 17 行："If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments."；第 60–63 行是发布规则；第 67 行："Do NOT close or modify any parent issue." | **读 issue 正文和评论**（找 spec 来源）；按依赖顺序**逐张建 issue**；**原生阻塞边**（没有就在正文写 "Blocked by"）；来源是已有 issue 时设**父子关系**（"make each ticket its sub-issue (tracker doc's operation)"）；**打 `ready-for-agent` 标签**（"unless instructed otherwise"）；**不改、不关父 issue**。 |
| **implement** | 第 9 行："If the user passes a ticket reference, fetch it from the issue tracker and state its title before starting. If the reference is ambiguous, ask." | **读票**。另外：调 tdd（第 11 行）、调 code-review（第 15 行）、提交到当前分支（第 17 行）。frontmatter 是 `disable-model-invocation: true`。 |
| **tdd** | 不读 tracker。第 10 行只读 `GLOSSARY.md` 和 ADR；第 22 行要求先和用户确认 seams："Before writing any test, write down the seams under test and confirm them with the user." | 没有 tracker 操作。 |
| **code-review** | 第 13 行："The issue tracker should have been provided to you…"；第 29 行（找 spec 来源的第 1 条）："Issue references in the commit messages (`#123`, `Closes #45`, GitLab `!67`, etc.), fetched via the workflow in the tracker doc." | **读 issue**（从 commit 里的引用找到 spec），找不到时依次看参数给的路径、`docs/`、`specs/`、`.scratch/`，最后问用户（第 27–32 行）。基准点没给时问用户（第 19 行）。两轴用**并行子 agent**（第 11、58–60 行）。 |
| **grill-with-docs** | 不读 tracker。全文只有一行："Call the Skill tool twice, for "grilling" and "domain-modeling"."（固定 SHA 下 grilling 和 domain-modeling 的 SKILL.md 里也没有 tracker / issue 字样，用 `git grep` 核对过。） | 没有 tracker 操作；只写 `GLOSSARY.md` 和 `docs/adr/`。 |
| **triage** | 第 11 行（PR 作为请求来源，"see the issue-tracker config"）；第 13–17 行（每条评论都要加 AI 免责声明）；第 43 行（标签映射）；第 58 行（"Query the issue tracker and present three buckets"）；第 70–86 行（按结论处理）。 | **按标签列出 issue**、**读正文、评论、标签、作者、日期**、**加/改标签**（每个 issue 恰好一个类别标签和一个状态标签）、**发评论**（agent brief、needs-info 的分诊记录）、**关闭**、看"reporter 在上次分诊之后有没有回复"、外部 PR、写 `.out-of-scope/*.md`。 |
| **setup-matt-pocock-skills** | 第 38–51 行（Section A：选 tracker）；第 53–59 行（Section B：triage 标签，只在装了 triage 时运行）；第 106 行（在 GitHub/GitLab 上创建缺的标签）；第 108–116 行（种子模板；"For "other" issue trackers, write `docs/agents/issue-tracker.md` from scratch using the user's description."）。 | 写 `docs/agents/issue-tracker.md`、`triage-labels.md`、`domain.md`；在 GitHub/GitLab 上 `label create`。 |

GitHub 种子模板（`setup-matt-pocock-skills/issue-tracker-github.md`）列出的操作，就是这些 skill 默认期待 tracker 具备的全部操作：Create、Read（`number,title,body,labels,comments`）、List（按 label 和 state 过滤）、sub-issue、Blocking（原生依赖）、Count open blockers、Comment、Apply/remove labels、Close（先评论再关闭）、PR 作为分诊来源，以及 Wayfinding 一节的 Map / Child ticket / Frontier query / Claim（assignee）/ Resolve（评论、关闭、追加到 map）。

平台的 `plat` 提供的操作有：`spec create`、`tickets import [--append]`、`spec confirm`、`spec show`、`ticket view [--version]`、`ticket edit`、`ticket retry/approve-protected/allow-path/cancel`、`spec cancel/cleanup/resume/retry-final/waive-final`、`blocked`、`run logs`（`packages/cli/src/index.ts`）。平台**没有**标签、评论、指派、关闭（只有 cancel）、列出 spec 的命令，spec 也不能挂到别的父项下面。

## 3. 模板原文（固定 SHA，逐字）

### 3.1 spec-template（`skills/engineering/to-spec/SKILL.md` 第 21–75 行）

````markdown
<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>
````

### 3.2 issue-template（`skills/engineering/to-tickets/SKILL.md` 第 84–103 行）

````markdown
<issue-template>

## Parent

A reference to the parent issue on the tracker (if the source was an existing issue, otherwise omit this section).

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective, not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- A reference to each blocking ticket, or "None (can start immediately)". Omit this section when blockers were set as native edges.

</issue-template>
````

紧跟在模板后面的一句（第 105 行）对两种模板都有效："In either form, avoid specific file paths or code snippets: they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts, not a working demo, just the important bits."

### 3.3 local-ticket-template（`skills/engineering/to-tickets/SKILL.md` 第 69–82 行）

````markdown
<local-ticket-template>

# <NN>: <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective, not a layer-by-layer implementation list.

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None (can start immediately)".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</local-ticket-template>
````

### 3.4 setup 的 tracker 种子模板里和发布有关的原文

- GitHub："## When a skill says "publish to the issue tracker"\n\nCreate a GitHub issue." / "## When a skill says "fetch the relevant ticket"\n\nRead it as in **Read an issue** above."
- GitLab："Create a GitLab issue." / "Run `glab issue view <number> --comments`."
- Local："Create a new file under `.scratch/<feature-slug>/` (creating the directory if needed)." / "Read the file at the referenced path. The user will normally pass the path or the issue number directly."；约定是"The spec is `.scratch/<feature-slug>/spec.md`"，每张票一个文件 `.scratch/<feature-slug>/issues/<NN>-<slug>.md`，"Triage state is recorded as a `Status:` line"，"Comments and conversation history append to the bottom of the file under a `## Comments` heading"。

（triage 的 AGENT-BRIEF 模板和 needs-info 模板也是要发到 tracker 上的固定格式，见 `triage/AGENT-BRIEF.md` 第 39 行起、`triage/SKILL.md` 第 92–106 行。按 P12 的结论它们留在 GitHub 上，这里不再摘录。）

## 4. 规划侧冲突（tracker 文档要写清楚的）

"现模板"指 `docs/agents/templates/pilot-issue-tracker.md`。

| # | 冲突 | skill 原文出处 | 平台现状 | tracker 文档要写什么 | 只靠文档能解决吗 |
| --- | --- | --- | --- | --- | --- |
| P1 | **标签** | to-spec 第 19 行 "Apply the `ready-for-agent` triage label"；to-tickets 第 63 行 "Apply the `ready-for-agent` triage label unless instructed otherwise" | 平台没有标签。现模板没提标签，`triage-labels.md` 还是 GitHub 的五个标签 | "平台没有标签：一个 draft spec、刚导入的票，就相当于 `ready-for-agent`；skill 说打标签时什么都不做"。`triage-labels.md` 的 `ready-for-agent` 一行注明"在 plat 上没有对应标签" | 能（to-tickets 自己写了 "unless instructed otherwise"） |
| P2 | **发布 spec 要的参数** | to-spec 只说 "publish it to the project issue tracker" | `plat spec create` 必须带 `--project`、`--type feature\|bug\|improvement`、`--title`，中文标题还要 `--slug`，正文要用 `--file` 传 | 怎么选 type；先把模板正文写进临时文件；slug 的规则（现模板已写）；project id 写死在文档里 | 能 |
| P3 | **读 spec 全文和评论** | to-tickets 第 17 行 "fetch it and read its full body and comments" | `plat spec show` 的文本输出**不打印正文**（`format.ts` 的 `specText` 只有状态、票、边、告警、验收包），只有 `--json` 的 `.spec.body` 里有正文；`plat ticket view` 的文本输出同样没有 body。平台没有评论 | "读 spec：`plat spec show S-n --json`，正文在 `.spec.body`；spec 和票都没有评论"。更好的办法是让 `plat spec show` / `plat ticket view` 也打印正文（改平台） | 能（文档写 `--json`）；改平台更稳 |
| P4 | **父子关系** | to-tickets 第 63 行 "If the source was an existing issue, make each ticket its sub-issue (tracker doc's operation)"；issue-template 的 `## Parent` | 票导入时就属于 `S-n`，不用另设父；但平台**不能导入不属于任何 spec 的票**。spec 本身也没有父，不能挂到 GitHub 的 map 或请求 issue 下 | "sub-issue 就是 `plat tickets import S-n`；to-tickets 必须对着一个 S-n 运行，没有就先 `/to-spec`；`## Parent` 一节写 `S-n`"。spec 要不要记它来自哪个 GitHub issue，属于地图的 (c) 附带信息，平台目前没有这个字段 | 票这边能；spec 的来源链接要平台加字段 |
| P5 | **逐张发布 vs 一次导入** | to-tickets 第 63 行 "publish one issue per ticket in dependency order (blockers first) so each ticket's blocking edges can reference real identifiers. Use the platform's native blocking relationship" | 整个 `tickets.yaml` 一次导入，要么全成功要么全不写；边用文件里的 `key`，导入后才有 T-n；一个 draft spec 只能导入一次，之后只能 `--append` | 现模板已写导入方式。还要补：导入失败就整份改完重导，不要拆开一张张导；之后加票用 `--append` | 能（skill 原文就说 "How depends on the tracker"） |
| P6 | **票正文的结构**（地图 Notes 里说的"翻译"问题） | issue-template 有四节：Parent / What to build / Acceptance criteria / Blocked by | tickets.yaml 有 `title`、`body`、`acceptance`、`blocked_by`，另外必填 `key`、`repo`、`type`、`modules`，可选 `protected_paths_ok`、`contract`、`refs`、`environment`（`ticket-import.ts` 用 `z.strictObject`，多一个键就拒绝）。模型把模板内容"翻译"成字段，结构是否保留没有规则保证。`/context/ticket.md` 由 `context.ts` 重新排版：标题、`Type:`、`## Acceptance criteria`（每行只有 `- `，没有勾选框）、`## Modules`、`## Details`+body。页面不显示正文 | 规定映射：`body` = 按 issue-template 渲染出的 markdown **原文**（`## Parent` 写 S-n；`## What to build`；`## Acceptance criteria` 带 `- [ ]`；平台用原生边，所以按 skill 自己的规则省略 `## Blocked by`）；`acceptance` = Acceptance criteria 每一行去掉 `- [ ] ` 之后的原文，必须和 body 里的逐字相同；`blocked_by` 就是原生边 | 写入这一侧能；**展示和渲染要改平台**：`ticket.md` 直接给出 body 原文，不要再自己拼一份 Acceptance criteria；页面显示正文；importer 最好校验 body 里的验收行和 `acceptance` 一致 |
| P7 | **"不要写文件路径" vs 必填的路径字段** | to-tickets 第 105 行 "avoid specific file paths or code snippets"；to-spec 第 55 行同义 | `modules`（glob）和 `protected_paths_ok`（具体文件）必须写路径 | "路径只写在 `modules` / `protected_paths_ok` 字段里，正文照 skill 的要求不写路径" | 能 |
| P8 | **confirm 与 "不要改父 issue"** | to-tickets 第 67 行 "Do NOT close or modify any parent issue." | 地图已定：批准拆分后 skill 导入、展示告警、问一次"开工吗"，答"是"就执行 `plat spec confirm`，把 spec 从 draft 改成 planned。现模板写的是 "A person does this… A skill never confirms." | 把"发布票"在本 tracker 上的操作定义成：导入 → 原样展示导入告警 → 问一次"开工吗" → 答"是"就 `plat spec confirm S-n` → 告诉人之后只需要等验收包、合 PR、处理 `plat blocked`。并写明"confirm 不改 spec 的正文，也不关闭 spec，不属于 skill 说的 modify parent"。删掉 "A skill never confirms" | 文档能写，但这是 tracker 文档和 skill 原文**唯一的正面冲突**，要实测模型听哪一边。实测不稳也不必 fork：退回"由人执行 confirm"即可 |
| P9 | **quiz 时展示的内容不够** | to-tickets 第 44–48 行，每张票只显示 Title / Blocked by / What it delivers | 人在 confirm 之前还要看 repo、type、modules、保护路径、契约边（operations-manual 第 4 步列的四件事） | "在本 tracker 上，quiz 时每张票还要列 repo、type、modules、protected_paths_ok、contract" | 能（skill 列的是最少要显示的内容） |
| P10 | **spec 模板没有 seams 一节** | to-spec 第 15–17 行要确认 seams；模板里没有对应的节 | AFK prompt 写的是 "/context/spec.md…里面的 seams 已经确认"，design.md 也说 spec.md 里"包括已确认的 seams 和共享名字"。但模板不保证 seams 会写进去 | "确认过的 seams 和共享名字写进 `## Testing Decisions`（模板本来就有 "Which modules will be tested" 一项），每条一行"。不加新节，模板节名一字不改 | 能 |
| P11 | **local-ticket-template 的 `Status:` 行** | to-tickets 第 77 行 `**Status:** ready-for-agent` | 只有 local tracker 才用这个模板；平台走 issue-template 一侧 | 写明"本 tracker 属于 'real issue tracker' 一支，用 issue-template" | 能 |
| P12 | **triage 整套操作平台都没有** | triage 全篇：标签状态机、评论（agent brief、needs-info，带 AI 免责声明）、关闭、`.out-of-scope/`、外部 PR、"reporter activity since the last triage notes" | 平台没有标签、评论、指派、关闭，也没有"还没分诊的请求"这种实体 | tracker 文档分成两部分：**进来的请求和 wayfinder map 留在 GitHub/GitLab**（照抄 setup 的 github/gitlab 种子模板对应几节），**spec 和票在 plat**。triage 得出 `ready-for-agent` 之后的下一步就是 `/to-spec` | 能（tracker 文档本来就是自由文本，"other" 类型由用户描述） |
| P13 | **wayfinder 也靠同一份 tracker 文档**（不在问题列表里，顺带记下） | wayfinder：map issue、子 issue、原生阻塞边、claim（assignee）、resolve（评论、关闭、追加到 map） | 平台都没有 | 同 P12，留在 GitHub/GitLab | 能 |
| P14 | **现模板过时的内容** | — | "One spec can only change one repo in M1" 和 GLOSSARY 的 Repo / Spec 定义矛盾；"A skill never confirms" 和地图决策矛盾；没写 labels、评论、读正文的方法、`ticket edit`、`--append`。`external_blocked_by` "must be empty in M1" 仍是代码现状（`ticket-import.ts` 第 149 行），可以保留 | 改模板；已经装进规划仓库的那份怎么跟着更新，是地图 "Not yet specified" 里的问题 | 能 |
| P15 | **grill-with-docs 依赖的 grilling 不在 engineering 目录** | grill-with-docs 调用 "grilling"；固定 SHA 下 grilling 在 `skills/productivity/grilling/`，不在 `skills/engineering/` | 平台记录和挂载的是 `skills/engineering`。规划机装 skills 时如果只装 engineering，grill-with-docs 会找不到 grilling（triage 第 76 行也调用 grilling） | 不归 tracker 文档管：操作手册写明规划机要装 `productivity/grilling`。沙箱不 grill，不受影响 | 能 |

## 5. 执行侧冲突（AFK 覆盖层要写清楚的）

| # | 冲突 | skill 原文出处 | 平台现状 | 覆盖层要写什么 | 只靠覆盖层能解决吗 |
| --- | --- | --- | --- | --- | --- |
| E1 | **沙箱里看到的 tracker 文档指向 `plat`** | implement 第 9 行 "fetch it from the issue tracker"；code-review 第 13、29 行 "fetched via the workflow in the tracker doc" | 规划仓库（后端）的 `docs/agents/issue-tracker.md` 就是 plat 文档，会被 clone 进沙箱，可沙箱里没装 `plat`，也连不上 API（design.md："沙箱不调 `plat`、不连平台 API"）。前端仓库没有 tracker 文档，code-review 会提示 "tell the user to run `/setup-matt-pocock-skills`" | "本次运行的 tracker 就是 `/context`：票在 `/context/ticket.md`，spec 在 `/context/spec.md`（整体审查时还有 `/context/tickets.md`）。不要读 `docs/agents/issue-tracker.md`，不要调用 `plat`，不要提示运行 setup" | 能 |
| E2 | **implement 只能由人调用** | implement 的 frontmatter `disable-model-invocation: true` | Cursor 文档："Set `disable-model-invocation: true` to make a skill behave like a traditional slash command, where it is only included in context when you explicitly type `/skill-name` in chat."；changelog（2026-05-07）："`/skill-name` invocations work in -p print mode"。M0 实测过按绝对路径读 SKILL.md 能照做。design.md 现在写的是"不依赖 implement skill" | prompt 里写"读 `/home/agent/.cursor/skills/implement/SKILL.md` 并照做"（M0 验证过这种写法），或者 prompt 以 `/implement` 开头（未实测）。地图 (b) 要改成跑 implement，design.md 那句也要跟着改 | 能 |
| E3 | **implement 结尾自己调用 code-review** | implement 第 15 行 "Once done, call the Skill tool with "code-review" to review the work." | 平台的 review 是单独一个阶段（新开沙箱和会话，`review.md`），再跑一次会花双倍时间和 token | "跳过 implement 里调用 code-review 的那一步，平台会另起一个 review 阶段"；或者明确保留，作为自检 | 能 |
| E4 | **tdd 要和用户确认 seams** | tdd 第 22 行 "confirm them with the user. No test is written at an unconfirmed seam." | AFK 运行中没人回答。现在的 prompt 已经写了 "里面的 seams 已经确认，不要再向任何人确认" | 保留现有写法。前提是 P10 保证 spec 里真的写了 seams | 能（M0 实测过） |
| E5 | **重构归 review 阶段，但平台的 review 不改代码** | tdd 第 38 行 "Refactoring is not part of the loop. It belongs to the review stage (see the `code-review` skill)" | `implement.md` 写着"按它的红 → 绿 → 重构流程做"，和固定 SHA 的 tdd 原文不符。平台的 review 只读；review-fix 只处理 mustFix；code-review 的 smell 按 skill 规定都是 judgement call，会进 suggestions，结果没有人处理 | 把 prompt 改成"红 → 绿，不在循环里重构"；再由平台决定 smell 交给谁（review-fix 是否顺带处理，还是只写进验收包） | 能（是平台自己的决定） |
| E6 | **code-review 要一个基准点** | code-review 第 19 行 "If they didn't specify one, ask for it."；第 21 行用三点 diff `git diff <fixed-point>...HEAD` | `run.json` 有 `baseSha`。现在的 `review.md` 用两点 diff `git diff <baseSha>..HEAD` | "基准点是 `/context/run.json` 的 `baseSha`"，并让 skill 用它自己的三点 diff | 能 |
| E7 | **code-review 找 spec 来源** | code-review 第 27–32 行：先看 commit 里的 issue 引用，再看参数给的路径，再看 `docs/` 等目录，最后问用户 | 进入 review 时，worker 已经给 commit 补上了 `Spec: S-n` / `Ticket: T-n` trailer（`executor.ts` 在 implement 运行之后 stamp），但这不是 `#123` 的形式，沙箱里也取不到 | 把 `/context/ticket.md` 当作"用户传入的路径"（第 2 条来源）。单票审查时要写明 **Spec 轴对照的是票**，`spec.md` 只是背景，否则 Spec 轴会把 spec 里其他票负责的内容都报成 "missing"。整体审查时对照 `spec.md` 和 `tickets.md` | 能 |
| E8 | **code-review 的输出格式和平台要的不一样** | code-review 第 78–80 行：分 `## Standards` / `## Spec` 两段，"Do **not** merge or rerank findings"，最后一行汇总，"Don't pick a single winner across axes" | 平台要 `<result>` JSON：`verdict`、`mustFix`（file/line/problem）、`suggestions`、`uncertainties` | 先按 skill 的格式汇总，再把每一条分进 mustFix 或 suggestions：文档化标准的硬性违反、Spec 轴的 (a) 缺失和 (c) 实现错了放 mustFix；baseline smell 一律放 suggestions；(b) scope creep 怎么归要平台定。verdict 规则是"任一轴有 mustFix 就是 fix"，这是门槛，不是跨轴排名。建议给 mustFix 每一项加 `axis` 字段，保留两轴（要改平台 schema） | 能（schema 小改） |
| E9 | **code-review 要并行子 agent** | code-review 第 11、58–60 行 | 见第 6 节 | 见第 6 节 | 能（方案 C 不依赖 Cursor 的 Task 工具） |
| E10 | **子 agent 继承 `--force`** | — | Sandcastle 用 `agent --print --output-format stream-json --model <m> --force <prompt>` 启动；Cursor 文档说子 agent "inheriting your credentials, rules, and approval policy" | review 运行里写明"子 agent 也只读，不改文件、不提交"（方案 C 下这一条自然成立） | 能 |
| E11 | **implement 结尾的 "Commit your work to the current branch"** | implement 第 17 行 | 和平台一致；平台另外要求不 push、不换分支、不自己加 trailer | 保留现在 prompt 里的这几条 | 能 |

**需要 fork 的：没有。** 上面每一条要么能写进 tracker 文档或覆盖层，要么是平台自己的代码改动（P3、P4 的 spec 来源字段、P6 的渲染和页面、E8 的 `axis` 字段）。P8 和 E1 是最要先实测的两条。

## 6. Cursor CLI 无头模式能不能跑 code-review 的并行子 agent

### 一手证据

- **官方 CLI changelog，2026 年 3 月**："Subagents in the CLI. Parallel agents execute locally with live status in interactive, headless, and editor sessions, inheriting your credentials, rules, and approval policy. Max mode and custom-key setups propagate to subagents."
- **官方 CLI changelog，v2026.08.11**："Single-turn runs wait for their subagents. Headless and single-turn runs drain delegated subagents and include their completion before exiting, instead of cutting off while background shells or dev servers are still running."
- **官方 subagents 文档**："You can use subagents in the editor, CLI, and Cloud Agents."；"Agent sends multiple Task tool calls in a single message, so subagents run simultaneously."；"Nested launches also need Task tool access in the current mode, and hooks or tool policies can block spawning."；"Running five subagents in parallel uses roughly five times the tokens of a single agent."。文档没有单独说 `-p` 下有没有限制；headless 文档页也没提子 agent。
- **平台固定的 CLI 版本**：`.sandcastle/Dockerfile` 里是 `ARG CURSOR_CLI_VERSION=2026.10.22-27dcf5f`，晚于上面两条 changelog。
- **反面证据（论坛）**：
  - "Sub-Agents in Cursor-CLI"（2026-02-20 到 03-03）：CLI 2.5.20 里缺 Task 工具，staff 说只有部分账号能复现，修复后报告人确认 "the Task tool is available to Cursor now and I'm able to use sub-agents on CLI"。
  - "Task tool missing"（IDE，2026-03-25；staff 2026-04-15 给出原因）：子 agent 依赖内部的 Composer 模型，团队管理员屏蔽 Composer 就会去掉 Task 工具。
  - "Nested subagent…"（SDK，2026-09-17）：顶层 agent 的 task 工具正常，只是嵌套的那一层有问题。code-review 只开一层子 agent，不受影响。

**结论**：按官方文档和 changelog，平台用的 CLI 版本在无头模式下**能**并行跑子 agent，也会等子 agent 跑完才退出。但 Task 工具是否注入由**服务端按账号、套餐和团队模型策略**决定，我们的账号、沙箱和 `--print --force` 组合**没有实测**。另外两件事也没验证：子 agent 跑的时候父 agent 没有输出，会不会触发 Sandcastle 的 `idleTimeoutSeconds`；stream-json 里子 agent 的事件长什么样。

### code-review 的两轴在沙箱里怎么跑

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A：照 skill 原样跑 | 一次 review 运行，agent 读 code-review 的 SKILL.md，自己开两个并行子 agent，最后由父 agent 输出 `<result>` | 最接近"原样跑 matt 的 code-review" | 依赖服务端开关；token 约两倍；有没有触发 idle timeout 未知；两轴的过程混在一个 Run 的日志里 |
| B：单个 agent 依次做两轴 | 覆盖层写"如果没有 Task 工具，先做 Standards 并写成报告，再做 Spec" | 不依赖 Task 工具 | 失去 skill 明说要的上下文隔离（"so they don't pollute each other's context"），只能当兜底 |
| **C：平台拆成两次运行（推荐）** | worker 把 review 拆成 `review-standards` 和 `review-spec` 两个运行，各开新沙箱和新会话，可以并行。两份 prompt 都指向 code-review 的 SKILL.md："第 1–3 步照做（基准点、spec 路径已经给你）；你就是第 4 步里的 Standards（或 Spec）子 agent，用第 4 步给这个子 agent 的 brief 原文作答，不要再开子 agent"。两份结果由 worker 用代码按第 5 步拼起来（不合并、不重排，保留 `axis`） | 不依赖 Cursor 的 Task 工具；两轴天然隔离；每轴一个 Run，日志和时长分开记；和"每次 `run()` 一个 `Output.object`"的做法一致；可以只重跑一轴；符合设计原则 1（"调度是确定性的，不交给 LLM"），和平台替代 implement-spec 的思路一样 | skill 第 5 步的汇总从模型挪到了平台代码；要起两次沙箱 |

推荐 C。理由：它只用覆盖层（告诉 agent 执行 skill 的哪几步、扮演哪个子 agent），不 fork；可靠性不取决于 Cursor 服务端。A 可以先在 Mac 上实测（最小 prompt：`-p --output-format stream-json` 下开两个子 agent，看 stream-json 里有没有两个 task 调用、会不会触发 idle timeout、`<result>` 能不能照常取到），稳定以后可以作为可选项。

## 7. 没能验证的

- Cursor CLI `2026.10.22-27dcf5f` 在我们的沙箱、账号和 `--print --force` 下有没有 Task 工具，子 agent 能不能并行跑完，会不会触发 Sandcastle 的 idle timeout：都没实测（本机没有 Cursor API key，也没有 Mac 环境）。
- prompt 以 `/implement` 开头，在 `-p` 下会不会被当成调用 skill：只有 changelog 的一句话，没实测。
- P8：tracker 文档里"confirm 不算 modify parent"这个定义，模型会不会照做：没实测。
- 论坛帖的内容是用 WebFetch 摘要读的，没有逐字核对；changelog 和 subagents 文档的引文是抓取原页后 grep 核对过的。

## 8. 来源

- mattpocock/skills @ `59db609eb1e18aaf59b63284d0e52255aff0c63c`：`skills/engineering/{to-spec,to-tickets,implement,implement-spec,tdd,code-review,grill-with-docs,triage,setup-matt-pocock-skills,wayfinder,domain-modeling}/…`、`skills/productivity/grilling/SKILL.md`
- [Cursor Docs：Subagents](https://cursor.com/docs/context/subagents)
- [Cursor Docs：Skills](https://cursor.com/docs/context/skills)
- [Cursor Docs：Headless / CI](https://cursor.com/docs/cli/headless)
- [Cursor CLI Changelog](https://cursor.com/docs/cli/changelog)
- [论坛：Sub-Agents in Cursor-CLI](https://forum.cursor.com/t/sub-agents-in-cursor-cli/152453)
- [论坛："Task" tool missing. Prevents sub-agent launch](https://forum.cursor.com/t/task-tool-missing-prevents-sub-agent-launch/155817)
- [论坛：Nested subagent gets a broken tool schema…](https://forum.cursor.com/t/nested-subagent-gets-a-broken-tool-schema-for-launching-further-subagents-no-working-task-tool-contradicts-docs/172035)
- 本仓库：`docs/agents/templates/pilot-issue-tracker.md`、`docs/design.md`、`docs/operations-manual.md`、`GLOSSARY.md`、`packages/pipeline/prompts/*.md`、`packages/pipeline/src/context.ts`、`packages/cli/src/{index,format}.ts`、`packages/shared/src/ticket-import.ts`、`packages/api/src/tickets/views.ts`、`packages/worker/src/executor.ts`、`.sandcastle/Dockerfile`；Sandcastle 0.12.0 `dist/index.js`（cursor provider 的 `buildPrintCommand`）
