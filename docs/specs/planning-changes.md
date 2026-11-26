# 规划时改的文件交给 worker

**技术方案 · 待审 · 2026-11-26**

规划时（grill-with-docs、to-spec、to-tickets）在规划仓库里改的文件，执行票的 worker 都要能读到。规划前就有的未提交改动不交出去。哪些是这次规划改的，由人在 confirm 时选，平台不猜；没选就不放行，不能悄悄留在本机。

送的方式不变（ADR 0005）：confirm 把选中的文件作为补丁发给平台，平台在任何票开工前把它提交到集成分支的第一个提交（规划提交），票的分支从集成分支切出，worker 在沙箱里的仓库自然就有这些文件，收尾时它们跟代码在同一个 PR 里进 `main`。这份方案只改「补丁里放哪些文件」和「规划仓库认不出来时怎么办」。

## 0. 起因

S-62（控制塔审代码）在 Mac 上规划时改了 5 个文件：`GLOSSARY.md`、`docs/adr/0010-…`、新建的 `docs/adr/0012-…`、`docs/design.md`、`docs/specs/in-platform-review.md`。confirm 之后：

- 平台上 S-62 的规划仓库为空，没有规划补丁，`~/.afk/planning/S-62/` 里也没有补丁备份。5 个文件原样留在 checkout 里，worker 一个也读不到。
- 第一张票「规划文档与术语」要 agent 写 GLOSSARY 的新词、ADR 0012 和 design.md 的状态说明，等于让它对着旧文件把人本地已经写好的内容重写一遍。

原因有两处，都在 CLI：

1. **规划仓库只从 tracker 文档读。** `plat spec create` 从 `docs/agents/issue-tracker.md` 第一行读规划仓库。这个 checkout 的 tracker 文档是仓库里提交的 GitHub 版，读不出来，需求就没有规划仓库。`confirm` 看到规划仓库为空，不读 checkout、不发补丁，也不打任何提示。
2. **带的范围写死成几个路径。** 就算认出了规划仓库，`PLANNING_DOC_PATHS` 也只有 `GLOSSARY.md`、`docs/adr/`、`AGENTS.md`（多上下文时加上术语表地图和各上下文的术语表、ADR）。`docs/design.md`、`docs/specs/*.md` 这类规划时一起改的文件不带，也不提醒。

另外，现在只要在这几个路径里，规划前就有的未提交改动也会一起交出去。

## 1. 使用体验

人在规划仓库的 checkout 里有一处没提交的改动：`src/foo.ts` 改了一半。他开始规划一个新需求。

1. `/grill-with-docs` 里 agent 在 `GLOSSARY.md` 加了两个新词，新建 `docs/adr/0013-….md`，改了 `docs/design.md` 的一节。
2. `/to-spec`、`/to-tickets` 照常，最后导入票。
3. to-tickets 问「开工吗？」，人答「是」，agent 运行 `plat spec confirm S-n`。checkout 里有本地改动、又没说怎么处理，confirm 拒绝并列出：

   ```
   S-n: 规划仓库里有这些本地改动，要说明哪些交给 worker：
     M  GLOSSARY.md
     A  docs/adr/0013-….md
     M  docs/design.md
     M  src/foo.ts
   这次规划改的用 --send <路径> 交给平台，其余用 --keep-local <路径> 留在本机
   （也可以 --send-all / --keep-local-all）。没交出的文件 worker 读不到。
   ```

4. agent 把清单给人看，问哪些是这次规划改的。人回：「除了 `src/foo.ts` 都是」。agent 运行：

   ```sh
   plat spec confirm S-n --send GLOSSARY.md --send docs/adr --send docs/design.md --keep-local src/foo.ts
   ```

5. 平台收下补丁，plat 把交出去的文件从 checkout 收走（`docs/adr/0013-….md` 删掉，另外两个还原成 HEAD），`src/foo.ts` 不动。
6. 第一张票开工时，集成分支第一个提交就是规划提交，里面有 GLOSSARY、ADR 0013 和 design.md 的改动，没有 `src/foo.ts`。

checkout 里没有本地改动时，confirm 和现在一样直接执行，不用选。

## 2. 术语、决定和要改的文档

实现的第一张票只改文档，后面的票按它写代码。

**GLOSSARY**（「规划」一组）：

- 改 **Planning docs（规划文档）**：从「规划时写下的术语表、ADR 和写给 agent 的规范」改成「规划仓库里这次规划改的文件，在 confirm 时由人选定交给平台：通常是术语表、ADR、设计文档和 spec 设计稿，不限路径和类型。本机专用的规划文件（tracker 文档、`docs/agents/`、本机规则文件）不在其中」。后半句「规划时的改动不由人提交，跟着这个 Spec 的代码一起进 PR」不变。
- **Planning commit（规划提交）**、**Scratch files（过程文件）** 不改。过程文件本来就不该出现在 checkout 里，出现了会被列进 confirm 的清单，由人选择留下。

**ADR 0013：规划文档由人在 confirm 时选定，不按路径挑。** 取代 ADR 0005 里「规划文档是哪几个路径」的部分；0005 其余内容（平台替人提交、规划提交是集成分支的第一个提交、补丁合不进去时 retry / waive）不变。要点：

- confirm 列出规划仓库里所有本地改动的文件，人选哪些交给平台；有改动又没选时不放行。
- 规划仓库认不出来、导入时有改动却在页面确认，都要说出来，不能悄悄放行。
- 放弃的方案见第 6 节。

**要改的文档**：

- `docs/adr/0005-…`：头部加一行「规划文档的范围被 ADR 0013 取代」。
- `docs/operations-manual.md`：1.3 表格「代码推到了远端」一行的例外说明；第 1 步 grill「这些改动不用提交」一段；第 4 步 confirm 的第二、四、五条，改成第 3–5 节的行为，写明 `--send`、`--keep-local` 的用法。
- `packages/cli/src/agent-docs.ts` 生成的「Planning on this machine」：最后一条从「When grilling changes `GLOSSARY.md` or `docs/adr/`」改成「grilling、to-spec、to-tickets 在这个仓库里改的文件都不提交、不推送」；再加一条「`plat spec confirm` 列出本地改动要你选时，把清单给人看，问哪些是这次规划改的，再用 `--send` / `--keep-local` 重跑；不要自己猜」。
- 本仓库 `CLAUDE.md`「在这个仓库里规划」：加同样一条。本仓库的 checkout 没有用 afk-setup 生成本机规则（tracker 文档是提交的 GitHub 版），不写在这里，agent 就不知道要问。

## 3. confirm 交出什么

### 3.1 清单

在规划仓库的 checkout 里，列出相对远端默认分支（HEAD 和它的 merge-base，和现在的补丁基准一样）有改动的文件：

- 没提交的改动（暂存的和没暂存的）；
- 新建、没被忽略的文件（遵守 `.gitignore` 和 `.git/info/exclude`）；
- 提交了但没推送的提交里改的文件；
- 删除的文件。

本机专用的规划文件不进清单：tracker 文档、`docs/agents/`、`CLAUDE.local.md`、`.cursor/rules/afk-platform.mdc`。它们大多已经登记在 `.git/info/exclude` 里，这里再按路径排除一次，因为有的仓库（比如本仓库）把 tracker 文档提交了。

### 3.2 选择

- `--send <路径>`：交给平台，可以给目录，可重复。
- `--keep-local <路径>`：留在本机，可以给目录，可重复。
- `--send-all`、`--keep-local-all`：其余没提到的全部交出或全部留下。
- 清单里每个文件都要被覆盖到。有没覆盖到的，confirm 拒绝，按第 1 节第 3 步的样子列出它们，什么都不发、不收走。
- 同一个文件既被 `--send` 又被 `--keep-local` 覆盖时报错。路径不在清单里时报错（防止打错字以为送了）。
- 清单为空时不用选，和现在一样直接执行。

### 3.3 补丁和收走

- 补丁：选中的文件相对基准的 diff（`--binary --full-index`），和现在的算法一样，只是路径表从固定的 `PLANNING_DOC_PATHS` 换成选中的文件。API 和 worker 都不检查补丁里的路径（worker 用 `git apply --cached --3way`），不用改。
- 收走：平台收下后，选中文件里没提交的改动从 checkout 收走，和现在的 `putPlanningDocsAside` 一样（改过的还原成 HEAD，新建的删掉），只是路径换成选中的文件。已经提交的不动。没选中的文件不动。
- 备份照旧放在 `~/.afk/planning/S-n/`。`retry-planning` 放回和重发时，路径用备份补丁里实际有的文件，不再用固定路径表。

### 3.4 拦下的情况

在现有的「补丁超过 1 MB 拒绝」「有未解决的冲突标记拒绝」之外：选中的文件名像密钥（`.env`、`.env.*`、`*.pem`、`*.key`、`id_rsa*`、`*.p12`）时拒绝，提示加进 `.gitignore` 或改用 `--keep-local`。

### 3.5 做不到的

同一个文件里既有规划前的改动、又有这次规划的改动时，只能整份交出或整份留下。碰到这种情况，先在本地提交或丢掉规划前的那部分，再 confirm。

## 4. 规划仓库认不出来时

- **`plat spec create`**：先读 tracker 文档；读不出来，或者 tracker 文档里的项目不是 `--project` 时，用当前 checkout 的 origin 去匹配项目里登记的仓库（`sameRepo`），匹配到就作为规划仓库发上去。`plat bug` 一样。
- **`plat spec confirm`**：需求还没有规划仓库、当前 checkout 又是项目里的某个仓库时，把它作为规划仓库一起发上去。`ConfirmBody` 加可选的 `planningRepo`。API 只在需求的 `planning_repo_id` 为空时接受；已经有、且和发来的不一样时返回 409，说明应该在哪个仓库里 confirm。
- **还是认不出来**（当前目录不在项目的任何仓库里）：照旧不发补丁，但不能静默。需求没有规划仓库时打出：「这个需求没有规划仓库，没有带任何本地改动；要带上，在规划仓库的 checkout 里运行 plat spec confirm」。

## 5. 导入时的记录和页面确认

- `plat tickets import` 记的 `planningDocsAtImport` 改用第 3.1 节的清单，只记文件名。规划仓库认不出来时用第 4 节的匹配。
- **确认请求不带补丁、而导入时记下有本地改动**（页面确认，或者 CLI 在规划仓库以外 confirm）：API 拒绝，返回 409，列出这些文件，说明去规划仓库里运行 `plat spec confirm`。
- 人确实不要这些改动时，确认请求带 `leavePlanningChanges: true`：照常确认，规划提交是默认分支当时的最新提交，验收包和 PR 描述注明「规划改动未带上：<文件>」，和现在的 `waive-planning` 一样。页面上是确认按钮旁的「不带这些改动，照样确认」，CLI 是 `plat spec confirm --leave-planning-changes`。
- CLI 在规划仓库里用 `--keep-local-all` 确认，是人明确选了留下，不算没带上，不注明。
- 导入时情况不明（`unknown`）时，页面照旧给黄色预检，不拦。

## 6. 为什么这些不做

- **按路径或文件类型挑**（比如只带 Markdown）：这次的问题就是范围写死。
- **全部本地改动都送**：会把规划前的未提交改动一起交出去。
- **开始规划时给工作区拍快照，自动区分规划前后**：能处理同一文件两种改动混在一起的情况，但要多一套快照、逐文件三方合并、切换分支检测和收走规则，而这种情况很少。这份方案的第一版就是这样写的，因为太复杂放弃。
- **只把文档挂到 `/context/` 给 worker，不提交**：仓库里的文件还是旧的，agent 会看到两个版本；这些文档也到不了 `main`。ADR 0005 已经放弃过「文档正文存在平台、一直从平台挂载」。
- **要求开始规划前工作区干净**：把整理工作推给人，而「有没提交的改动又开始规划」正是要支持的情况。
- **其他仓库的本地改动**：只看规划仓库。其他仓库的票照旧在 `/context/domain/` 读规划提交里的术语表和 ADR；`/context/domain/` 的挂载范围这次不变。

## 7. 接口

| 位置                            | 变化                                                                                                                               |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `plat spec confirm`             | 清单和选择（`--send` / `--keep-local` / `--send-all` / `--keep-local-all`）、拦截、`--leave-planning-changes`；补发 `planningRepo` |
| `plat spec retry-planning`      | 放回和重发按备份补丁里的路径                                                                                                       |
| `plat spec create` / `plat bug` | tracker 文档读不出规划仓库时用 origin 匹配                                                                                         |
| `plat tickets import`           | `planningDocsAtImport` 按第 3.1 节的清单                                                                                           |
| `POST /specs/{id}/confirm`      | `planningRepo?`、`leavePlanningChanges?`；不带补丁且导入时有改动时 409                                                             |
| 需求页面                        | 确认被拒时列出文件；「不带这些改动，照样确认」                                                                                     |
| `@afk/shared`                   | `PLANNING_DOC_PATHS` 不再决定补丁范围，只留给 `/context/domain/` 挂载用                                                            |

不改数据库表结构：`planning_repo_id`、`planning_patch`、`planning_docs_at_import` 都已经有；「规划改动未带上」沿用 waive 的记法。

## 8. 拆票

项目 afk-platform 一个需求。改路由的票要 `pnpm gen:api`。

| 票                    | 内容                                                                                                            | 依赖   |
| --------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| T1 文档               | 第 2 节：GLOSSARY、ADR 0013、ADR 0005 头部、操作手册、`agent-docs.ts` 生成的规划规则、本仓库 `CLAUDE.md`        | —      |
| T2 confirm 选择文件   | 第 3 节：清单、四个选项和拒绝、按选中文件出补丁和收走、密钥文件名、`retry-planning` 的路径                      | T1     |
| T3 规划仓库兜底       | 第 4 节：spec create / `plat bug` 的 origin 匹配；`ConfirmBody.planningRepo` 和 API 的接受、409；认不出时的提示 | —      |
| T4 导入记录和页面确认 | 第 5 节：`planningDocsAtImport` 按清单、不带补丁时的 409、`leavePlanningChanges`、验收包和 PR 描述、页面按钮    | T2、T3 |
| T5 演练               | 第 9 节末尾的演练                                                                                               | T4     |

## 9. 验收

新行为先写红测试：git 用临时仓库真跑，API 测试连真 Postgres。

**清单和选择**

- 没提交的改动、新建未跟踪的文件、没推送的提交里的文件、删除的文件都在清单里；被忽略的文件和本机专用的规划文件不在（包括被提交了的 tracker 文档）。
- 有本地改动、没给选项：confirm 拒绝，列出全部文件，什么都没发，checkout 没变。
- 只覆盖了一部分：拒绝，只列出没覆盖到的。
- `--send` 和 `--keep-local` 覆盖同一个文件、或给了不在清单里的路径：报错。
- 选中的文件进补丁，worker 能 `git apply --cached --3way`；没选中的不进补丁，confirm 后原样留在 checkout。
- 选中 `docs/design.md`、`docs/specs/x.md`、一个新建的 ADR、一个二进制文件：都进规划提交。
- 选中一个没推送的提交里的文件：进补丁，提交本身不动。
- 选中 `.env.local`：拒绝；改成 `--keep-local` 后放行。
- 清单为空：不用选项，直接确认。

**两条确认路**（CLI 在规划仓库里，和页面 / 规划仓库外）都要成立：

- 导入时记下有本地改动：CLI 在规划仓库里按选择带上并收走；页面确认和规划仓库外的 CLI confirm 都返回 409 并列出文件；带 `leavePlanningChanges` 后两条路都能确认，验收包和 PR 描述注明未带上的文件。
- 导入时没有本地改动：两条路都直接确认。

**两种规划仓库来源**（tracker 文档读出，和 origin 匹配）都要成立：

- spec create 记下规划仓库；confirm 按第 3 节列清单、按选择带上。
- 需求没有规划仓库、在项目仓库的 checkout 里 confirm：补登记并带上；已登记的是别的仓库时 409。
- 在项目以外的目录 confirm、需求没有规划仓库：输出说明没带任何改动。

**两次发送**（第一次 confirm，和 `retry-planning`）都要成立：

- 放回时按备份补丁里的文件三方合并，冲突标在文件里；重发后再次收走，没选中的文件始终不动。

**演练**（Mac 上 3000 端口的平台，演练项目，一次）：重放 S-62 的情形。在一个 tracker 文档是 GitHub 版的 checkout 里，先留一处无关的未提交改动，再规划：改 `GLOSSARY.md`、`docs/design.md`、`docs/specs/*.md`，新建一个 ADR，导入两张票后让 agent confirm。期望 agent 把清单拿给人选；规划提交里正好是这 4 处改动，无关的改动留在本机；第一张票的 agent 在集成分支上读到新版文件。结果写回本文档。
