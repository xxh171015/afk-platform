# 规划改动全部交给 worker

**技术方案 · 待审 · 2026-11-26**

规划时（grill-with-docs、to-spec、to-tickets）在规划仓库里写下或改动的文件，执行票的 worker 都要能读到；规划开始前就有的未提交改动不交出去。这份方案用「规划起点」划出这两部分，并让 confirm 在带不走时说出来，而不是悄悄留在本机。

## 0. 起因

S-62（控制塔审代码）在 Mac 上规划时改了 5 个文件：`GLOSSARY.md`、`docs/adr/0010-…`、新建的 `docs/adr/0012-…`、`docs/design.md`、`docs/specs/in-platform-review.md`。confirm 之后：

- 平台上 S-62 的规划仓库为空，没有规划补丁，`~/.afk/planning/S-62/` 里也没有补丁备份。5 个文件原样留在 checkout 里，worker 一个也读不到。
- 第一张票「规划文档与术语」要 agent 写 GLOSSARY 的新词、ADR 0012 和 design.md 的状态说明，也就是让它对着旧文件把人本地已经写好的内容重写一遍。

原因有两处，都在 CLI：

1. **规划仓库只从 tracker 文档读。** `plat spec create` 从 `docs/agents/issue-tracker.md` 第一行读规划仓库。这个 checkout 的 tracker 文档是仓库里提交的 GitHub 版，读不出来，需求就没有规划仓库。`confirm` 看到规划仓库为空，不读 checkout、不发补丁，也不打任何提示。
2. **带的范围写死成几个路径。** 就算认出了规划仓库，`PLANNING_DOC_PATHS` 也只有 `GLOSSARY.md`、`docs/adr/`、`AGENTS.md`（多上下文时加上术语表地图和各上下文的术语表、ADR）。`docs/design.md`、`docs/specs/*.md` 这类规划时一起改的文件不带，也不提醒。

另外，现在的范围以远端默认分支为基准，不能区分「规划时改的」和「规划前就有的」：人在 GLOSSARY 里有一段没提交的旧改动，再跑 grill，confirm 会把两者一起交出去。

## 1. 使用体验

人在规划仓库的 checkout 里有两处没提交的改动：`GLOSSARY.md` 里改了一个词的定义（A 段），`src/foo.ts` 改了一半。他开始规划一个新需求。

1. agent 按本机规划规则先跑 `plat sync`。规划仓库还没有进行中的规划起点，plat 给工作区拍一张快照，输出多一行：`规划起点：已记录（2 个未提交的改动算作规划前就有的）`。快照不动 index、分支和文件。
2. `/grill-with-docs` 里 agent 在 `GLOSSARY.md` 加了两个新词（B 段），新建 `docs/adr/0013-….md`，改了 `docs/design.md` 的一节。
3. `/to-spec` 前 agent 又跑一次 `plat sync`：起点已经有了，沿用，不重拍。`/to-tickets` 同样如此，最后导入票。
4. `plat spec confirm S-n` 输出：

   ```
   S-n: 规划改动交给平台，在任何票开工前提交到集成分支：
     GLOSSARY.md（只含规划起点之后的改动）
     docs/adr/0013-….md（新建）
     docs/design.md
   留在本机、不交给 worker（规划起点之前就有）：
     GLOSSARY.md（规划前的改动）
     src/foo.ts
   ```

5. 平台收下补丁，plat 把交出去的改动从 checkout 收走：`docs/adr/0013-….md` 删掉，`docs/design.md` 还原，`GLOSSARY.md` 只去掉 B 段、A 段原样保留，`src/foo.ts` 不动。规划起点清掉，下一轮规划重新记。
6. 第一张票开工时，集成分支第一个提交就是规划提交，里面有 B 段、ADR 0013 和 design.md 的改动，没有 A 段，也没有 `src/foo.ts`。

如果 agent 漏跑了 `plat sync`，第 4 步的输出里 grill 的改动会出现在「留在本机」一组，人和 agent 都能看到，用 `--include` 补带（第 5 节）。

## 2. 术语、决定和要改的文档

实现的第一张票只改文档，后面的票按它写代码。

**GLOSSARY**（「规划」一组）：

- 新增 **Planning baseline（规划起点）**：开始一轮规划时规划仓库工作区的快照：HEAD 加上当时所有没提交、没被忽略的文件。由 `plat sync` 在没有进行中的起点时记录，confirm 成功后清掉。规划改动就是这个快照之后的变化。_Avoid_：基线提交、stash。
- 改 **Planning docs（规划文档）**：从「规划时写下的术语表、ADR 和写给 agent 的规范」改成「规划起点之后，规划仓库里新写、改动或删除的文件；通常是术语表、ADR、设计文档和 spec 设计稿，不限路径和类型。本机专用的规划文件（tracker 文档、`docs/agents/`、本机规则文件）不算。规划起点之前就有的改动也不算」。后半句「规划时的改动不由人提交，跟着这个 Spec 的代码一起进 PR」不变。
- **Planning commit（规划提交）** 和 **Scratch files（过程文件）** 不改。过程文件本来就不该出现在 checkout 里，出现了会被列进 confirm 的输出，由人决定是否 `--leave-local`。

**ADR 0013：规划改动按规划起点划分，整份随需求提交。** 取代 ADR 0005 里「规划文档是哪几个路径、以远端默认分支为基准」的部分；0005 其余内容（平台替人提交、规划提交是集成分支的第一个提交、补丁合不进去时 retry / waive）不变。要点：

- 规划改动 = 规划起点之后规划仓库里的全部变化，不按路径或文件类型挑。
- 起点挂在本机规划规则已经要求的 `plat sync` 上，不改 Matt 的 skill 原文（ADR 0002 不 fork skill），也不依赖某一种 agent 工具的 hook。
- 带不走的改动要说出来：没有起点、认不出规划仓库、导入时有改动却在页面确认，都不能悄悄放行。
- 放弃的方案见第 8 节。

**要改的文档**：

- `docs/adr/0005-…`：头部加一行「范围部分被 ADR 0013 取代」。
- `docs/operations-manual.md`：1.3 表格「代码推到了远端」一行的例外说明；第 1 步 grill「这些改动不用提交」一段；第 4 步 confirm 的第二、四、五条，改成第 3–6 节的行为，写明 `--include`、`--leave-local`、`--new-plan` 的用法。
- `packages/cli/src/agent-docs.ts` 生成的「Planning on this machine」：`plat sync` 那条补一句「它也会记下规划起点：之后改的文件会在 confirm 时交给平台」；最后一条从「When grilling changes `GLOSSARY.md` or `docs/adr/`」改成「grilling、to-spec、to-tickets 在这个仓库里改的文件」。
- 本仓库 `CLAUDE.md`「在这个仓库里规划」：加一条「开始 grill-with-docs、to-spec、to-tickets 前先运行 `plat sync`」。本仓库的 checkout 没有用 afk-setup 生成本机规则（tracker 文档是提交的 GitHub 版），不写在这里，S-62 这种情况就不会记起点。

## 3. 规划起点

### 3.1 什么时候记

- 只有人（或 agent）显式运行 `plat sync` 时才记。plat 自我更新后顺带跑的那次同步（`syncMachine(onlyWhereInstalled = true)`）不记。
- 在当前目录所在的 git checkout 上记，不要求 tracker 文档：读不出 tracker 文档时，`plat sync` 照旧说「planning files: none here」，但仍然记起点。这样 tracker 文档不是平台版的 checkout 也有起点。
- 在 `plat sync` 写完本机规划文件之后记，所以 sync 自己对这些文件的改动算作起点之前。
- 已经有进行中的起点时不重拍，输出 `规划起点：沿用 <时间> 记录的`。超过 24 小时时多一句：「不是同一轮规划的话，运行 `plat sync --new-plan` 重新记录」。
- `plat sync --new-plan`：丢掉旧起点，重新记录。

### 3.2 存什么

用一份临时 index 做快照，不碰人的 index：

1. `read-tree HEAD`，`add -A`（遵守 `.gitignore` 和 `.git/info/exclude`，所以本机规划文件和被忽略的文件不进快照），`write-tree`。
2. `commit-tree <tree> -p HEAD`，提交说明写 `afk planning baseline`。
3. 存成引用 `refs/worktree/afk/planning-baseline`，防止被 gc。`refs/worktree/` 下的引用每个 worktree 各有一份，在另一个 worktree 里规划不会共用起点；普通 `git push` 也不会推它。

快照提交的父提交就是记录时的 HEAD（下文的 `H₀`），快照的树是 `B`。

### 3.3 什么时候清

- confirm 被平台收下后：引用改名为 `refs/afk/planning/S-n`，起点的 SHA 一起写进 `~/.afk/planning/S-n/`，供 `retry-planning` 用。需求合入或取消后，现在删备份目录的那一步顺便删掉这个引用。
- `plat sync --new-plan`。
- confirm 被拒时不清。

同一个 checkout 只有一个进行中的起点（第 8 节）。

## 4. confirm 交出什么

### 4.1 有起点时

记号：`B` 是起点快照里的内容，`W` 是现在工作区的内容（同样用临时 index `add -A` 得到），`O` 是现在算补丁的基准：HEAD 和远端默认分支的 merge-base 上的内容（和现在一样）。

1. **候选路径**：`B` 和 `W` 之间有差别的路径，包括新建、删除、改名（按删加处理）。规划中做的提交也自然算进去，因为 `W` 包含 HEAD。
2. **每个候选文件算出要交的内容 `R`**：`git merge-file` 三方合并，基准 `B`，一边 `O`，一边 `W`，得到「远端版本加上规划时的改动」。规划前那部分（`B` 相对 `O` 的差别）不进 `R`。
   - 起点时没有这个文件（规划时新建的）：`O` 也没有时，`R = W`；`O` 有时，按空文件为基准合并。
   - 规划时删掉的：`O` 和 `B` 一样时删除；不一样时算冲突。
   - 二进制文件：`O` 和 `B` 一样时 `R = W`，否则算冲突。
3. **冲突**：有任何一个文件合并冲突时，confirm 拒绝，列出这些文件，说明「规划前的改动和规划时的改动在同一处，无法分开」，让人在本地提交或丢掉规划前的那部分后再 confirm，或者对这个文件用 `--include` 整份交出。
4. **补丁**：`O → R` 的 diff（`--binary --full-index`），和现在一样发给平台。API 和 worker 都不检查补丁里的路径（worker 用 `git apply --cached --3way`），不用改。

### 4.2 留在本机的那一组

`O` 和 `W` 之间有差别、但规划时没有碰过的路径，以及候选文件里规划前的那部分。confirm 照样放行，但逐个列出（第 1 节第 4 步的第二组），JSON 输出里是 `leftLocal`。

在规划中切过分支（现在的 HEAD 不是 `H₀` 的后代）时，候选路径会混进分支差异。这种情况 confirm 拒绝，提示用 `plat sync --new-plan` 重记起点后再规划，或者用 `--include` / `--leave-local` 逐个指明。

### 4.3 没有起点时

比如在旧版 plat 上开始的规划，或者漏跑了 `plat sync`。这时 confirm 不猜：列出 `O` 和 `W` 之间所有改动的文件，拒绝执行，要求每个路径都用 `--include <路径>` 或 `--leave-local <路径>` 指明（可以给目录，可重复）。全部指明后照常发送，被 `--include` 的文件整份交出（相对 `O`）。

### 4.4 `--include` 和 `--leave-local`

- `--include <路径>`：这个路径整份交出（`R = W`），不管起点。用来补带漏记起点的规划改动。
- `--leave-local <路径>`：这个路径不交出，即使它是规划时改的。
- 两个都给同一个路径时报错。

### 4.5 拦下的情况

在现有的「补丁超过 1 MB 拒绝」「有未解决的冲突标记拒绝」之外：

- 要交出的文件名像密钥：`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`*.p12`。confirm 拒绝，提示加进 `.gitignore` 或用 `--leave-local`。
- 第 4.2 节的切换分支、第 4.3 节没指明完的路径。

## 5. 收走和放回

**收走**（取代 `putPlanningDocsAside`）：平台收下补丁后，对每个交出去的文件，把工作区里的内容改成「现在的 HEAD 加上规划前的改动」：`git merge-file`，基准 `H₀` 里的版本，一边现在 HEAD 里的版本，一边 `B`。

- 规划中没有 pull、没有提交时，结果就是 `B`：规划前的改动原样留着，规划时的改动收走。
- 规划中 pull 过：pull 进来的内容保留，不会被还原。
- 规划中把规划改动提交了：提交留着（和现在一样，已提交的不动）；PR 合并后 `git pull` 时两边内容相同，不冲突。
- 结果和 `B` 一样且和 HEAD 一样的文件，index 也还原成 HEAD。起点时不存在、现在 HEAD 也没有的文件删掉，空目录一起删，和现在一样。

**放回**（`retry-planning`，取代 `putPlanningDocsBack`）：用备份的补丁三方合并回 checkout，和现在一样；路径范围改成补丁里实际有的路径，不再用固定路径表。重新发送时用备份里的起点，按第 4 节再算一次。

## 6. 规划仓库认不出来时

- **`plat spec create`**：先读 tracker 文档；读不出来，或者 tracker 文档里的项目不是 `--project` 时，用当前 checkout 的 origin 去匹配项目里登记的仓库（`sameRepo`），匹配到就作为规划仓库发上去。`plat bug` 一样。
- **`plat spec confirm`**：需求还没有规划仓库、当前 checkout 又是项目里的某个仓库时，把它作为规划仓库一起发上去。`ConfirmBody` 加可选的 `planningRepo`。API 只在需求的 `planning_repo_id` 为空时接受；已经有、且和发来的不一样时返回 409，说明应该在哪个仓库里 confirm。
- **还是认不出来**（当前目录不在项目的任何仓库里）：照旧不发补丁，但不能静默。需求没有规划仓库时打出：「这个需求没有规划仓库，没有带任何本地改动；要带上，在规划仓库的 checkout 里运行 plat spec confirm」。

## 7. 导入时的记录和页面确认

- `plat tickets import` 记的 `planningDocsAtImport` 改用第 4 节的算法：有起点时是候选路径，没有起点时是相对 `O` 的全部改动，只记文件名。规划仓库认不出来时用第 6 节的匹配。
- **确认请求不带补丁、而导入时记下有规划改动**（页面确认，或者 CLI 在规划仓库以外 confirm），API 拒绝，返回 409，列出这些文件，说明去规划仓库里运行 `plat spec confirm`。
- 人确实不要这些改动时，确认请求带 `leavePlanningChanges: true`：照常确认，规划提交是默认分支当时的最新提交，验收包和 PR 描述注明「规划改动未带上：<文件>」，和现在的 `waive-planning` 一样。页面上是确认按钮旁的「不带这些改动，照样确认」，CLI 是 `plat spec confirm --leave-planning-changes`。
- 导入时情况不明（`unknown`）时，页面照旧给黄色预检，不拦。

## 8. 为什么这些不做

- **按文件类型或路径挑**（比如只带 Markdown）：这次的问题就是范围写死。规划时改了什么，交出去的就该是什么。
- **以远端默认分支为基准**：会把规划前的未提交改动一起交出去。
- **要求开始 grill 前工作区干净**：把整理工作推给人，而「有没提交的改动又开始规划」正是要支持的情况。
- **改 grill-with-docs 加一步「记起点」**：skill 是 Matt 原文的副本，平台不 fork（ADR 0002）；本机规划规则里已经有「先跑 `plat sync`」，挂在它上面就够了。
- **用 Claude Code / Cursor 的 hook 自动记**：每种 agent 工具做法不一样，规划机器上用哪种也不固定。漏记时 confirm 的两组列表能让人看到。
- **同一个 checkout 同时规划两个需求**：起点只有一个。真要并行，在另一个 worktree 里规划（起点按 worktree 分开，第 3.2 节）；这次不支持在同一个工作区里区分两轮规划的改动。
- **其他仓库的规划改动**：只看规划仓库。其他仓库的票照旧在 `/context/domain/` 读规划提交里的术语表和 ADR；`/context/domain/` 的挂载范围这次不变。

## 9. 接口

| 位置                            | 变化                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `plat sync`                     | 记规划起点（第 3 节）；`--new-plan`                                                                                            |
| `plat spec create` / `plat bug` | tracker 文档读不出规划仓库时用 origin 匹配（第 6 节）                                                                          |
| `plat spec confirm`             | 按起点算补丁、两组输出、`--include` / `--leave-local` / `--leave-planning-changes`、拦截（第 4、5、7 节）；补发 `planningRepo` |
| `plat spec retry-planning`      | 放回和重发按补丁里的路径和备份的起点（第 5 节）                                                                                |
| `plat tickets import`           | `planningDocsAtImport` 按新算法（第 7 节）                                                                                     |
| `POST /specs/{id}/confirm`      | `planningRepo?`、`leavePlanningChanges?`；不带补丁且导入时有改动时 409                                                         |
| 需求页面                        | 确认被拒时列出文件；「不带这些改动，照样确认」                                                                                 |
| `@afk/shared`                   | `PLANNING_DOC_PATHS` 不再决定补丁范围，只留给 `/context/domain/` 挂载用                                                        |

不改数据库表结构：`planning_repo_id`、`planning_patch`、`planning_docs_at_import` 都已经有；「规划改动未带上」沿用 waive 的记法。

## 10. 拆票

项目 afk-platform 一个需求。改路由的票要 `pnpm gen:api`。

| 票                    | 内容                                                                                                                         | 依赖   |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------ |
| T1 文档               | 第 2 节：GLOSSARY、ADR 0013、ADR 0005 头部、操作手册、`agent-docs.ts` 生成的规划规则、本仓库 `CLAUDE.md`                     | —      |
| T2 规划起点           | 第 3 节：快照、引用、`plat sync` 记录和沿用、`--new-plan`、24 小时提示、自我更新后的同步不记                                 | T1     |
| T3 按起点算补丁       | 第 4 节：候选路径、逐文件三方合并、冲突、两组输出、切换分支检测、没有起点时的拒绝、`--include` / `--leave-local`、密钥文件名 | T2     |
| T4 收走和放回         | 第 5 节：按 `H₀` 和 `B` 收走、引用改名和备份起点、`retry-planning` 的路径范围和重发                                          | T3     |
| T5 规划仓库兜底       | 第 6 节：spec create / `plat bug` 的 origin 匹配；`ConfirmBody.planningRepo` 和 API 的接受、409；认不出时的提示              | —      |
| T6 导入记录和页面确认 | 第 7 节：`planningDocsAtImport` 新算法、不带补丁时的 409、`leavePlanningChanges`、验收包和 PR 描述、页面按钮                 | T3、T5 |
| T7 演练               | 第 11 节末尾的演练                                                                                                           | T4、T6 |

## 11. 验收

新行为先写红测试：git 用临时仓库真跑，API 测试连真 Postgres。

**规划起点**

- `plat sync` 在没有起点时记一个，`refs/worktree/afk/planning-baseline` 存在；人的 index、HEAD、工作区文件都没变（前后 `git status --porcelain` 和 `git diff --cached` 一致）。
- 已有起点时再跑 `plat sync` 不重拍；超过 24 小时时有提示；`--new-plan` 重拍。
- tracker 文档不是平台版的 checkout 里，`plat sync` 也记起点。
- plat 自我更新后的同步不记起点。
- 被 `.gitignore` 或 `.git/info/exclude` 忽略的文件不进快照。

**confirm 交出的内容**

- 规划前已有未提交改动的文件 X、规划时没再碰：不进补丁，在「留在本机」里，confirm 后 X 原样。
- 规划前在 GLOSSARY 改了 A 段、规划时改了 B 段：补丁只有 B 段；confirm 后工作区的 GLOSSARY 只剩 A 段的改动。
- 规划时新建的文件、改动的非规划文档（`docs/design.md`、`docs/specs/x.md`）、删除的文件都进补丁。
- 规划时做了提交（没推送）：提交里的改动进补丁，提交本身不动。
- 规划前就有、没推送的提交：不进补丁。
- 规划中 pull 了默认分支：pull 进来的内容不进补丁，confirm 后也没被还原。
- A 段和 B 段改在同一处、合并冲突：confirm 拒绝并列出文件；对它 `--include` 后整份交出。
- 规划中切换了分支：confirm 拒绝；`--new-plan` 之后或逐个指明后能确认。
- 没有起点：confirm 拒绝并列出全部改动；全部用 `--include` / `--leave-local` 指明后照常发送，补丁内容和指明的一致。
- 要交出 `.env.local`：拒绝；`--leave-local` 后放行。
- 二进制文件改动进补丁，worker 能 `git apply --cached --3way`。

**两条确认路**（CLI 在规划仓库里，和页面 / 规划仓库外）都要成立：

- 导入时记下有规划改动：CLI 在规划仓库里 confirm 时带上并收走；页面确认和规划仓库外的 CLI confirm 都返回 409 并列出文件；带 `leavePlanningChanges` 后两条路都能确认，验收包和 PR 描述注明未带上的文件。
- 导入时没有规划改动：两条路都直接确认。

**两种规划仓库来源**（tracker 文档读出，和 origin 匹配）都要成立：

- spec create 记下规划仓库；confirm 按第 4 节带上规划改动。
- 需求没有规划仓库、在项目仓库的 checkout 里 confirm：补登记并带上；已登记的是别的仓库时 409。
- 在项目以外的目录 confirm、需求没有规划仓库：输出说明没带任何改动。

**两次发送**（第一次 confirm，和 `retry-planning`）都要成立：

- 用同一个起点，交出的路径一致；放回时三方合并，冲突标在文件里；重发后再次收走，规划前的改动还在。

**演练**（Mac 上 3000 端口的平台，演练项目，一次）：重放 S-62 的情形。在一个 tracker 文档是 GitHub 版的 checkout 里，先留一处无关的未提交改动，再 `plat sync`，改 `GLOSSARY.md`、`docs/design.md`、`docs/specs/*.md`，新建一个 ADR，导入两张票后 confirm。期望规划提交里正好是这 4 处规划改动，无关的改动留在本机，第一张票的 agent 在集成分支上读到新版文件。结果写回本文档。
