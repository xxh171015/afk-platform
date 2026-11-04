# 规划用到的 skill 会在 checkout 里写哪些文件、写在哪

研究票：[#167](https://github.com/xxh171015/afk-platform/issues/167)（地图 [#166](https://github.com/xxh171015/afk-platform/issues/166)「首次接入与规划提交零打扰」）。

只引一手来源：skill 原文和本仓库代码。

- 平台包的五个 skill：仓库 `skills/` 下的快照（main@627e732），按 `skills/VENDORED.md` 从 mattpocock/skills@`59db609eb1e18aaf59b63284d0e52255aff0c63c` 原样复制。逐个文件和上游同一 SHA 比对过，除了平台加的 `LICENSE` 以外完全一致，所以下文的行号既是快照的行号，也是上游的行号。
- 其他 Matt skill（prototype、research、wayfinder、setup-matt-pocock-skills）：读的是上游同一 SHA 的原文。下文用 `U` 代表 `https://github.com/mattpocock/skills/blob/59db609eb1e18aaf59b63284d0e52255aff0c63c/skills`。
- 上游 main（`4ae2317`，比固定 SHA 多 5 个提交）里，research、wayfinder、grilling 有改动，但只是加了一句「子 agent 用新的上下文窗口启动」，**和写哪些文件无关**（`gh api repos/mattpocock/skills/compare/59db609…main`）。所以无论机器上装的是固定版本还是 main，下文结论都成立。

## 分类依据

- **规划文档（Planning docs）**：GLOSSARY.md 第 23-25 行；[ADR 0005](../adr/0005-planning-docs-go-with-the-spec-committed-by-the-platform.md)。平台认的路径是 `PLANNING_DOC_PATHS = ["GLOSSARY.md", "docs/adr", "AGENTS.md"]`（`packages/shared/src/planning-docs.ts:5`），都相对仓库根目录。`plat spec confirm` 先建一个临时 index，把这三个路径下的文件 `git add -A` 进去（未跟踪的新文件也算），再和 `merge-base(HEAD, origin/<默认分支>)` 做 diff；如果 HEAD 已包含 `origin/afk/setup`、默认分支还没包含，就改为和 afk/setup 的 tip 做 diff。所以发出去的补丁包含：已提交但没推的、没提交的、未跟踪的，**只限这三个路径**（`packages/cli/src/planning-docs.ts:47-115`）。
- **过程文件（Scratch files）**：「规划过程中顺手产生、对后人没有用的东西，比如 prototype 草稿、research 笔记，以及平台流程为了规划临时造出的工作区和分支。不随需求提交；需求提交前由平台或 skill 清掉」。这一条出自规划机主 checkout 里**未提交**的 GLOSSARY.md 改动，第 27-29 行；main@627e732 上还没有这条。
- **不在 checkout 里**：写到代码托管（issue、label、远端分支）、平台，或者仓库外的目录。
- **接入改动（setup）**：上面三类之外的第四种情况。平台生成的文件在 `afk/setup` 上，走设置提交进 PR，不走规划提交（GLOSSARY.md 第 27-29 行「Setup commit」；[ADR 0006](../adr/0006-setup-goes-with-the-spec.md)）。

## 逐个 skill

### grill-with-docs

- 本身不写任何东西，只做一件事：「Call the Skill tool twice, for "grilling" and "domain-modeling".」（`skills/grill-with-docs/SKILL.md:7`）。描述里说的「creates docs (ADR's and glossary) as we go」（同文件第 3 行）都由 domain-modeling 来写。

### grilling

- 不写文件，不提交，不推送，也不建 issue。查事实的办法是派子 agent 去查，「Finding _facts_ is your job … dispatch a sub-agent to find it」（`skills/grilling/SKILL.md:28`）；结束条件是人确认达成共识，「Do not act on it until the user confirms」（第 30 行）。
- 分类：不产生文件。

### domain-modeling

| 写什么 | 路径 | 出处 |
| --- | --- | --- |
| 术语表，术语一定下来就当场改 | 单上下文：仓库根 `GLOSSARY.md` | `skills/domain-modeling/SKILL.md:12-22, 60-62` |
| ADR，满足三个条件才提议写 | `docs/adr/NNNN-slug.md`，编号取现有最大号加一；目录用到时才建 | `SKILL.md:66-74`；`ADR-FORMAT.md:3-5, 27` |
| 多上下文时的术语表和 ADR | 根目录 `GLOSSARY-MAP.md`、`src/<context>/GLOSSARY.md`、`src/<context>/docs/adr/` | `SKILL.md:24-38`；`GLOSSARY-FORMAT.md:34-58` |

- 原文只说写文件，没有提到 git commit、push 或建 issue。
- 分类：单上下文的产物属于**规划文档**，正好落在 `PLANNING_DOC_PATHS` 里。**多上下文的产物（`GLOSSARY-MAP.md`、`src/<ctx>/GLOSSARY.md`、`src/<ctx>/docs/adr/`）按定义也是规划文档，但不在 `PLANNING_DOC_PATHS` 里**：confirm 不会发送它们，平台也不会清掉它们，它们会一直留在人的 checkout 里。可平台自己是支持多上下文的：`plat init` 看到 `GLOSSARY-MAP.md` 就会写 Multi-context 段（`packages/cli/src/agent-docs.ts:33-35, 73`）。这里不一致。

### to-spec

- 原文的做法是「Write the spec … then publish it to the project issue tracker. Apply the `ready-for-agent` triage label」（`skills/to-spec/SKILL.md:19`）。发布到哪里由 tracker 文档决定：
  - GitHub 种子模板：「Create a GitHub issue」（`U/engineering/setup-matt-pocock-skills/issue-tracker-github.md:33-35`），属于**不在 checkout 里**（代码托管）。
  - 本地 markdown 种子模板：`.scratch/<feature-slug>/spec.md`（`U/engineering/setup-matt-pocock-skills/issue-tracker-local.md:7-8, 15`），在 checkout 里。
  - 平台 tracker 文档：「Write the spec markdown **outside this repo** (do not commit it)」，示例路径是 `~/.afk/planning/draft/spec.md`，然后 `plat spec create`；拿到 `S-7` 后，「keep process files under `~/.afk/planning/S-7/`」（`packages/cli/templates/platform.md:15-21`）。结果是 checkout 外有一份草稿，平台上有一个 Spec。
- 没有 tracker 文档时，原文要求叫人去跑 `/setup-matt-pocock-skills`（`SKILL.md:9`）。
- 原文不提交、不推分支。

### to-tickets

- 第 5 步按 tracker 发布（`skills/to-tickets/SKILL.md:58-67`）：
  - 本地文件：「`.scratch/<feature-slug>/issues/<NN>-<slug>.md`」（第 62 行），在 checkout 里。
  - 真实 tracker：每张票建一个 issue，设原生 blocking，打 `ready-for-agent`，来源是 issue 时挂成它的 sub-issue（第 63 行），**不在 checkout 里**。
  - 「Do NOT close or modify any parent issue.」（第 67 行）
- 平台 tracker 文档把它改成四步：票文件写到 `~/.afk/planning/S-7/`，并要求「Do not put these files in this repository」；然后 `plat tickets import`；然后问一次「开工吗？」；人同意就在本仓库跑 `plat spec confirm`（`packages/cli/templates/platform.md:34-49`）。结果是 checkout 外有票文件，平台上有票。
- 原文不提交、不推分支。

### prototype

- 代码放在「close to where it will actually be used (next to the module or page it's prototyping for)」，命名要让人一眼看出是原型（`U/engineering/prototype/SKILL.md:21`）。**路径不固定**。
  - logic 分支：一个自包含的 HTML 文件（`U/engineering/prototype/LOGIC.md:37`）。
  - UI 分支 A：在现有页面上用 `?variant=` 切换，**直接改已跟踪的页面文件**（`UI.md:20`、`UI.md:73`）。
  - UI 分支 B：按项目的路由约定新建一个 throwaway route，比如 `/prototype/<name>`（`UI.md:28, 75`）。
  - 两个 UI 分支都会把切换器放进「wherever shared UI lives in the project」（`UI.md:92`）。
  - 涉及持久化时，用「a scratch DB or a local file with a clear "PROTOTYPE, wipe me" name」（`SKILL.md:23`）。
- 收尾：「Fold any validated decision into the real code」，也就是**改产品代码**；然后「commit it to a throwaway branch, out of main, and leave a context pointer to that branch on the implementation issue」（`SKILL.md:26`）。UI 分支收尾时还要从 main 删掉落选的 variant 和切换器（`UI.md:100-105`）。原文没明说要 push，但要在 issue 上留指向这个分支的指针，实际上就得推。
- 分类：
  - 原型代码和改过的页面在 checkout 里是**过程文件**。它们不在 `PLANNING_DOC_PATHS` 里，confirm 不会发送，也不会清掉。
  - throwaway 分支和它的远端分支**不在 checkout 里**。按原文的意图，原型是一手资料，要从 issue 链接过去，**是要保留的**。
  - 「fold into the real code」这一步在规划阶段产出的是产品代码改动，既不是规划文档，也不是过程文件。按平台的流程，代码应该由票来写。

### research

- 「Write the findings to a single Markdown file … Save it where the repo already keeps such notes … if there is none, put it somewhere sensible and say where」（`U/engineering/research/SKILL.md:10-12`）。**路径不固定**。
- 单独使用时，原文不提交、不推送。在 wayfinder 里使用时，结果写在 throwaway 的 `research/<name>` 分支上，要推送，不开 PR，「it is never merged」（`U/engineering/wayfinder/SKILL.md:115`）。
- 分类：笔记文件在 checkout 里是**过程文件**，不在 `PLANNING_DOC_PATHS` 里。`research/<name>` 分支和它的远端分支**不在 checkout 里**，按原文要保留，因为票上有指向它的链接。

### wayfinder

- 地图和票都是 issue：地图打 `wayfinder:map`，票是子 issue，打 `wayfinder:<type>`；认领靠 assignee，解决靠评论加关闭，然后在地图正文追加一行（`U/engineering/wayfinder/SKILL.md:21, 25, 65-67, 125`）。这些全在代码托管上，**不在 checkout 里**。
- 用本地 markdown tracker 时，改为写 `.scratch/<effort>/map.md` 和 `.scratch/<effort>/issues/NN-<slug>.md`（`issue-tracker-local.md:25-30`），在 checkout 里。
- wayfinder 自己不写其他文件，文件由它调用的 research、prototype、grilling 和 domain-modeling 写（`wayfinder/SKILL.md:77-79`）。「Assets created while resolving a ticket are linked from the issue」（第 71 行）。

### setup-matt-pocock-skills

- 写的文件：
  - `CLAUDE.md` 或 `AGENTS.md` 里的 `## Agent skills` 段：有 CLAUDE.md 就写它，没有就写 AGENTS.md，两个都没有就问人（`U/engineering/setup-matt-pocock-skills/SKILL.md:76-102`）。
  - `docs/agents/issue-tracker.md`、`docs/agents/domain.md`，装了 triage 时还有 `docs/agents/triage-labels.md`（第 49 行、第 104-116 行）。
- 还可能做：`git init`、`git remote add origin`（第 51 行）；把旧的 `CONTEXT.md` 用 `git mv` 改名成 `GLOSSARY.md`（第 25 行）；在代码托管上 `gh label create`（第 106 行）。原文没有说要提交。
- 平台已经替代了这个 skill：`plat init` 写 `docs/agents/domain.md`、`docs/agents/triage-labels.md`，以及 CLAUDE.md 或 AGENTS.md 里的 `## Agent skills` 段，注释写的是「what setup-matt-pocock-skills would write, so nobody has to run it」（`packages/cli/src/agent-docs.ts:6-8, 55-79`）。`docs/agents/issue-tracker.md` 由 `plat init` 和 `plat tracker-doc` 生成（`packages/cli/src/init.ts:16`、`packages/cli/src/tracker-doc.ts`）。afk-setup 把这些都提交并推到 `afk/setup`（`skills/afk-setup/SKILL.md:40-46, 67`）。
- 分类：属于**接入改动**，在 `afk/setup` 上，走设置提交，不是规划文档。
  - 如果人在平台接入之后又自己跑一次 setup-matt-pocock-skills，它会用 GitHub 种子模板重写 `docs/agents/issue-tracker.md`，把平台的路由覆盖掉。
  - CLAUDE.md 不在 `PLANNING_DOC_PATHS` 里，AGENTS.md 在。所以 `## Agent skills` 段如果在规划时被写进 AGENTS.md，又不在 afk/setup 的基础上，confirm 会把它当规划文档发出去。

## tracker 文档会不会改变上面的结论

平台生成的 `docs/agents/issue-tracker.md` 由几部分拼成，依次是：routing 表、平台段、多仓库时的段落，最后是代码托管的种子模板原文，放在 `## On GitHub` 下（`packages/cli/src/tracker-doc.ts:81-90`）。

- **引到平台的**：to-spec 发布 spec，to-tickets 发布票，implement 取票，code-review 找 spec（`packages/cli/templates/routing.md:7-12`）。结论因此**改变**：to-spec、to-tickets 不再写 `.scratch/`，也不再在代码托管上建 issue，改为在仓库外的 `~/.afk/planning/…` 写草稿，再进平台（`platform.md:15-21, 34-40`）。平台段还把「process files」也指到 `~/.afk/planning/S-7/`（`platform.md:21`），但这句话只出现在 spec 发布那一条里。
- **留在代码托管的**：wayfinder 的地图和票，triage 的 label、needs-info 和 ready-for-agent，以及把 PR 当请求处理（`routing.md:13-17`）。wayfinder 的结论**不变**：都是 GitHub issue，不在 checkout 里。
- **规划文档**：平台段要求 `GLOSSARY.md`、`docs/adr/`、`AGENTS.md` 保持未提交、未推送，由 confirm 发送（`platform.md:22-26`）。这只是确认了 domain-modeling 的单上下文路径，**没有覆盖多上下文路径**。
- **tracker 文档完全没提的**：research 笔记写在哪，prototype 代码写在哪，`research/<name>` 和 prototype 的 throwaway 分支怎么处理。所以 research 和 prototype 的结论**不变**：它们照旧往 checkout 里不固定的位置写文件，按原文还会建分支并推送。另外，平台没有评论功能（`platform.md:11`），prototype 原文要求「leave a context pointer … on the implementation issue」，这件事在平台的票上做不到，只能留在 wayfinder 的 GitHub 票上。

## 总表

| skill | 写什么、写在哪 | 提交 / 推分支 / 建 issue | 分类 |
| --- | --- | --- | --- |
| grill-with-docs | 自己什么都不写，由 grilling 和 domain-modeling 写 | 都没有 | — |
| grilling | 什么都不写 | 都没有 | — |
| domain-modeling（单上下文） | 根目录 `GLOSSARY.md`，`docs/adr/NNNN-slug.md` | 都没有 | 规划文档，在 `PLANNING_DOC_PATHS` 里 |
| domain-modeling（多上下文） | `GLOSSARY-MAP.md`，`src/<ctx>/GLOSSARY.md`，`src/<ctx>/docs/adr/` | 都没有 | 规划文档，但**不在** `PLANNING_DOC_PATHS` 里，所以不发送也不清理 |
| to-spec | 平台 tracker：`~/.afk/planning/draft/spec.md`，然后进平台。本地 tracker：`.scratch/<slug>/spec.md`。GitHub：建 issue | 不提交、不推送；平台 tracker 下不建 issue | 平台 tracker 下不在 checkout 里 |
| to-tickets | 平台 tracker：`~/.afk/planning/S-N/NN-*.md`，然后进平台。本地 tracker：`.scratch/<slug>/issues/`。GitHub：建 issue | 不提交、不推送；平台 tracker 下不建 issue | 平台 tracker 下不在 checkout 里 |
| prototype | 模块或页面旁边，路径不固定。可能**改已跟踪的页面**，加共享的切换器组件，加「PROTOTYPE, wipe me」数据文件；最后把结论并进产品代码 | 提交到 throwaway 分支，实际上要推送；在 issue 上留指针 | checkout 里的是过程文件；分支在 checkout 外，按原文要保留；并进产品代码的部分两类都不属于 |
| research | 一个 Markdown 文件，放在「repo 平常放笔记的地方」，路径不固定 | 单独用时不提交；在 wayfinder 里提交到 `research/<name>` 并推送，不开 PR | checkout 里的是过程文件；分支在 checkout 外，按原文要保留 |
| wayfinder | GitHub 上的地图 issue、子 issue、label 和评论；本地 tracker 时写 `.scratch/<effort>/` | 建 issue | 平台 tracker 下不在 checkout 里，留在 GitHub |
| setup-matt-pocock-skills（平台用 `plat init` 和 afk-setup 代替） | CLAUDE.md 或 AGENTS.md 的 `## Agent skills` 段，`docs/agents/{issue-tracker,domain,triage-labels}.md` | 原 skill 不提交，但可能 `git init`、`git remote add`、`gh label create`；平台版提交并推到 `afk/setup` | 接入改动，走设置提交，不算规划文档 |

## 对「提交需求时哪些文件随需求进 PR、哪些过程文件清掉、谁来清」（#170）的提示

1. **过程文件没法按路径约定认出来。** to-spec 和 to-tickets 的过程文件已经被 tracker 文档挪到仓库外。剩下真正落在 checkout 里的过程文件来自 research 和 prototype，两者的路径都不固定：「where the repo already keeps such notes」，「next to the module」。
2. **过程文件不只是新文件。** prototype 的 UI 分支 A 会改已跟踪的页面，「fold into the real code」会改产品代码。所以「把未跟踪文件删掉」不等于清干净，清理还得包括还原已跟踪文件的改动。
3. **过程文件不只是工作区里的文件，还有分支。** research（在 wayfinder 里）和 prototype 都会建 throwaway 分支，而且要推送。在人的 checkout 里做这件事，就意味着切分支，或者在当前分支上提交，这和「分支不变」冲突。这些远端分支按原文**本意要保留**，因为票上链接着它们，不能当过程文件一并删掉。#170 要把「谁来清」的范围分清楚：checkout 里的残留要清，推出去的一手资料分支要留。
4. **规划文档的路径不止三个。** domain-modeling 的多上下文布局（`GLOSSARY-MAP.md`、`src/<ctx>/GLOSSARY.md`、`src/<ctx>/docs/adr/`）不在 `PLANNING_DOC_PATHS` 里，confirm 不发送，也没有任何一方去清它们。
5. **confirm 只发三个路径，等于默认把其他一切当作「不随需求走」，但没有任何一方清理它们。** 反过来也一样：哪个 skill 碰了 `AGENTS.md` 或 `docs/adr/`，都会被当作规划文档发出去。如果要在人自己的 checkout 里规划，tracker 文档和 `## Agent skills` 段就得放进 checkout，skill 才能读到。这时 AGENTS.md 里的接入段会不会被 confirm 当规划文档发出去，要看补丁的基准：只有 HEAD 包含 `origin/afk/setup` 时，基准才会换成 afk/setup（`packages/cli/src/planning-docs.ts:47-58`）。这是 #170 和「在自己的 checkout 里规划」要一起回答的问题。
