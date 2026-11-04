# 操作手册：从 grill 到平台实现落地

用在自己的 Mac 上，把一个需求从「想清楚」走到「PR 合并」。两种场景：

- **场景 A**：只改一个后端仓库。
- **场景 B**：前后端各一个仓库，后端出契约，前端按契约实现，再加一张联调票。

先在试点仓库（`afk-pilot-backend`、`afk-pilot-frontend`）上亲自跑一遍，走通再换成自己的仓库。试点仓库的真实验收记录在 `docs/specs/m1-acceptance/`、`docs/specs/m2-acceptance/`，下面的票文件就是照它们改的。

## 0. 谁做什么

```
你（在 agent 里，有人在场）                平台（无人值守）
─────────────────────────────            ──────────────────────────────────
1 /grill-with-docs   把需求问透
2 /to-spec           写 spec，发布 ───────► plat spec create  → S-n（draft）
3 /to-tickets        拆票，发布 ─────────► plat tickets import → T-n，依赖图
4 你读票和告警，plat spec confirm ───────► 调度：每票 implement → 门禁 → review → 合并
                                          全部票 done → 整体 review/fix → 开 PR → 验收包
5 你看验收包，在 GitHub 上合并 PR ◄──────
```

人只在 1~4 和第 5 步出现，外加处理 blocked 的票（第 6 节）。**平台从不替你合并 PR，也不替你 confirm。**

## 1. 一次性准备

### 1.1 启动平台

```sh
cd ~/code/afk-platform
scripts/up.sh            # 第一次会检查并引导补齐缺项；--check 只检查
```

- 前提：3000、5173 端口空着（旧的 API/worker 要先停）。
- 启动后：API `http://127.0.0.1:3000`，页面 `http://127.0.0.1:5173`。终端里 Ctrl-C 停全部（worker 会先中止手头的 run，最多等 60 秒；再按一次立即全停）。
- 这个终端要一直开着。平台停了，spec 不会前进，但已有数据都在 Postgres 里，重启后接着做。

### 1.2 接入一个项目（`/afk-setup`，每个项目一次）

规划的那台机器（可以就是这台 Mac）上只需要手动装一次 skill，然后在 Cursor 里跑 `/afk-setup`。这一个包里有 afk-setup 和规划用的 grill-with-docs、grilling、domain-modeling、to-spec、to-tickets（按平台固定的提交从 mattpocock/skills 原样复制，见仓库 `skills/`），**不用另装 Matt 的 skill**。装法和 `npx skills@latest add mattpocock/skills` 一样，它会问装哪些 skill（全选）、装给哪些 agent、装在项目里还是全局：

```sh
npx skills@latest add xxh171015/afk-platform
```

- **项目级**（在规划仓库里运行，选 Project）：skill 放在仓库的 `.agents/skills`，`/afk-setup` 把它们连同 `skills-lock.json` 一起推到 `afk/setup`，随第一个需求的 PR 进默认分支。之后团队里每个人拉下代码就有同一版本，推荐团队用。
- **全局**（选 Global，或加 `-g`）：只装在你自己的 `~/.agents/skills`。同名的 skill 会被覆盖成平台用的版本。

不想回答问题时可以直接写全：`npx skills@latest add xxh171015/afk-platform --skill '*' -y`（项目级，在规划仓库里运行），全局再加 `-g`。以后平台升级了，在规划仓库（项目级）或任意目录（全局）运行 `plat update`：它从平台下载最新的 plat 替换自己，再按 skill 现在装在哪一级把它们重装一遍。`plat` 发现自己或这些 skill 过期时也会提示 `plat update`。

这个包里只放平台用到的 skill。Matt 的其他 skill（tdd、diagnosing-bugs 等）需要的话，自己用 `npx skills@latest add mattpocock/skills` 选着装，平台不固定它们的版本。不要装 `setup-matt-pocock-skills` 来跑：它会把 tracker 文档和 `## Agent skills` 改回指向 GitHub Issues，规划就不再发到平台（改错了重跑 `/afk-setup` 能恢复）。

在 Cursor 里打开装着项目各个仓库的工作区，输入 `/afk-setup`。它自己一步步做完，不问确认类的问题：只有平台地址连不上、或要接入的仓库不在工作区里时才会问。它不开 PR，接入改动推到每个仓库的 `afk/setup` 分支，随第一个需求的 PR 进默认分支，你在那时一起审（ADR 0006）：

1. **工具**：缺 Node 20+、git，或者 `gh` 没登录时，每样用一行告诉你要运行的命令，不替你装、不替你登录。平台地址先试 `http://127.0.0.1:3000`，连不上才问你一次；确认连得上后用 `plat connect <地址>` 让 plat 记住（存在 `~/.afk/plat.json`），之后不用配 `AFK_API_URL`。临时连别的平台时，`--api-url` 和 `$AFK_API_URL` 仍然优先。`plat` 从平台下载（`GET /cli/plat.mjs`，和平台同一版本），装到 PATH 里已有的、你能写的目录；实在没有时才往你的 shell 配置里加一行，并告诉你加在哪个文件。确认规划 skill 都在，漏选了就按 afk-setup 所在的那一级（项目或全局）补装。
2. **仓库**：工作区里的 git 仓库就是项目的仓库。**规划仓库**（跑 grill / to-spec / to-tickets 的那个）依次这样定：已经有平台写的 tracker 文档的那个；只有一个仓库就是它；只有一个带 openapi 文件的就是它；否则是工作区里第一个仓库。报告里会写明选了哪个。
3. **登记**：在规划仓库的 worktree 里直接跑 `plat init --yes --with …`（改动都在 `afk/setup` 分支上，不进默认分支）。`plat init` 会登记项目和仓库，在规划仓库里写好 tracker 文档 `docs/agents/issue-tracker.md`，以及原本由 `setup-matt-pocock-skills` 写的东西（`docs/agents/domain.md`、`docs/agents/triage-labels.md`、`AGENTS.md` 或 `CLAUDE.md` 里的 `## Agent skills` 一节）；**不用再跑 setup-matt-pocock-skills**。它还会让 worker 检查每个仓库上的 GitHub App（见 1.3）。
4. **补齐接入条件**：每个仓库开一个 `afk/setup` 分支（在旁边的 worktree 里，不动你自己的分支和文件），按 1.3 补 `.sandcastle/gates.yaml`、`AGENTS.md`（联调环境不在这里配，见 1.3 最后一行）；推上去后用 `plat repo check <仓库名> --branch afk/setup` 让平台在真实沙箱里跑一遍门禁，不过就改到过为止。
5. **不开 PR，不用先合**：提交说明里写明替换了哪些已有文件（比如原来指向别的 tracker 的 `issue-tracker.md`）。平台切每个需求的集成分支时，先把 `afk/setup` 合到默认分支最新提交上（**设置提交**），票按它的 `gates.yaml` 过门禁，接入改动跟代码在同一个 PR 里进默认分支；默认分支已经包含 `afk/setup` 后就不再叠。`plat spec confirm` 只在某个仓库的默认分支和 `afk/setup` 上都没有 `gates.yaml` 时拒绝开工。
6. **在规划仓库的 `afk/setup` 工作树里规划**：报告会给出它的路径（`<规划仓库>-afk-setup`），tracker 文档和 agent 文档在那里；第 2 节的 grill / to-spec / to-tickets / confirm 都在这个目录里做。带着设置的需求合入后，就可以回到自己的 checkout 规划。

以后多了仓库不用再跑：把它加进工作区，规划时票用到它，`plat tickets import` 说它不属于项目，规划的 agent 就自己用 afk-setup 接入它，再接着导入，你只会看到一行「已接入 X，门禁检查：…」，不用合并什么。平台升级或 `plat` 提示「run the afk-setup skill」时，agent 同样会自己跑。已有的都保留，只补缺的、更新过期的。逐条登记和改设置的命令见附录 D（`plat init` 也可以自己在终端跑）。

### 1.3 每个仓库要满足的条件

| 条件 | 怎么满足、怎么检查 |
| --- | --- |
| GitHub App 已装到这个仓库，有 Contents 写、Pull requests 写、Checks 读、Commit statuses 读 | 开 PR、转 ready、删分支都靠它。`plat init` 每次都让持有 App 凭据的 worker 检查一遍，逐个仓库打印结果；没装或权限不够时给出要打开的页面（由运行平台的人处理）。GitLab 仓库不检查。 |
| 默认分支是 `main`，代码推到了远端 | 平台只 clone 远端。grill 产出的 `GLOSSARY.md`、ADR 是例外：**不用提交也不用推**，`plat spec confirm` 会带上（见第 1 步、第 4 步）。 |
| `.sandcastle/gates.yaml` | 门禁：`setup` 加若干条命令（typecheck、test、lint……），其中一条写 JUnit 并在 `junit` 里给出路径。`plat repo check <仓库名> --branch <分支>` 让平台在沙箱里对推上去的分支跑一遍，打印哪条失败和输出结尾。格式见 `skills/afk-setup/gates.md`。 |
| `AGENTS.md` / 编码规范 | 无人值守的 agent 会读它，前后端仓库都要有。要写明怎么跑测试，以及「无人值守运行」：遇到只有人能定的事，输出 `cannot-proceed` 结束。 |
| （场景 B 的前端）契约副本 | 前端有 `contract/openapi.yaml`，并由它生成 client（试点是 `src/api/schema.d.ts`）；票里写 `contract:` 时，平台会把后端契约送到前端票，agent 要把副本更新成一致。 |
| （有联调票时）联调环境 | 不在接入时配：需求要联调时，`/to-tickets` 按 tracker 文档的「Integration tickets」把缺的东西拆成票，放在同一个需求里（被依赖的仓库加 `.sandcastle/integration/compose.yaml`、`seed-<仓库名>` 种子服务；e2e 所在仓库加 `npm run e2e`，把 JUnit 写到 `reports/e2e-junit.xml`）。`plat tickets import` 发现缺了又没有票补时会警告。 |

沙箱镜像不是仓库的条件：所有仓库的票都在平台的同一个镜像里跑（平台仓库的 `.sandcastle/Dockerfile`，有 Node 22、npm、pnpm、PostgreSQL）。仓库需要镜像里没有的工具链时，`plat repo check` 会失败在那条命令上，要由运行平台的人往镜像里加。

### 1.4 tracker 文档是什么

grill / to-spec / to-tickets 默认往 GitHub Issues 写。规划仓库里的 `docs/agents/issue-tracker.md` 让它们改成写平台；`plat init`（由 `/afk-setup` 调用）生成它（单独生成用 `plat tracker-doc --project <P> --repo <名字> > docs/agents/issue-tracker.md`，只打印、不写文件）。

- 文档第一行是版本标记（平台版本、skills SHA、项目和仓库）；平台版本只写在仓库根 `package.json` 的 `version`，改了平台、想让规划过的人知道时手动加一，文档是否过期则看整份比对；开头的分流表说明哪些事去平台（to-spec、to-tickets、implement 读票、code-review 找 spec，用 `plat`），哪些留在代码托管上（wayfinder、triage、把 PR 当请求，用 `gh` 或 `glab`）。多个仓库且登记了契约路径时，文档会自带跨仓库的规则，不用再手工补。
- 之后每次 `plat spec create` 和 `plat tickets import` 都会检查两件事，只告警，不改变命令的结果和退出码：规划仓库里的 `docs/agents/issue-tracker.md` 和现在重新生成的结果是否整份一致（模板更新、项目配置改了、有人手改过都会发现），以及 to-spec、to-tickets、afk-setup 是否是平台用的版本（先看规划仓库里的 `.agents/skills` 等项目级目录，没有再看 `~/.claude/skills`、`~/.cursor/skills`、`~/.agents/skills`）。告警里会写出按那一级更新的命令。

## 2. 场景 A：只有后端

### 第 1 步 grill（想清楚）

在后端仓库（规划仓库）的 `afk/setup` 工作树里打开 agent（设置还没随需求合入默认分支时；见 1.2 第 6 步），运行：

```
/grill-with-docs
```

它会反复追问，并在过程中补 `GLOSSARY.md` 和 `docs/adr/`（规划文档）。**这些改动不用提交、也不用推送**，就留在工作区里：第 4 步 `plat spec confirm` 会把它们发给平台，平台在任何票开工前替你提交到这个需求的集成分支上，跟代码在同一个 PR 里进 `main`（ADR 0005）。同一需求里其他仓库的票在 `/context/domain/` 读到它们。to-spec / to-tickets 的过程文件写到仓库外（`~/.afk/planning/<spec>/`），不进 git。

### 第 2 步 to-spec（发布 spec）

```
/to-spec
```

- 不会再采访你，只汇总刚才的对话；**它会让你确认「测试 seams」**，认真看：无人值守的 agent 不能再问你，seams 在这里定死。
- 发布时它调用 `plat spec create`，打印 `S-n`。spec 缺了 to-spec 模板的某一节、或节名被改，以及 `## Testing Decisions` 里没写 seams 时，会在 stderr 告警（不拒绝，正文照存，只统一换行符和末尾换行）。标题没有英文单词时必须带 `--slug <english-slug>`（中文标题生成不了 slug）。
- spec 此时是 draft，什么都还没开始跑。

### 第 3 步 to-tickets（拆票并导入）

```
/to-tickets S-n
```

- 它给出编号的票清单，让你检查**粒度**和**依赖边**；确认前不会发布。
- 然后让 to-tickets 把票写成一个目录，一张票一个 `.md` 文件（格式见附录 A），并执行 `plat tickets import S-n <目录>`。导入要么全成功要么全不写，**一次列出全部问题**。**每个 draft spec 只能导入一次**，导入后要加票用 `--append`（第 6 节）。

### 第 4 步 读票、confirm

```sh
plat spec show S-n          # spec 正文、票、依赖边、导入告警
```

对着看四件事：

1. 每张票的验收标准是否能用 HTTP 或公开接口的测试验证（验收包只在门禁 JUnit 里有对应测试且通过时才标 `verified`）。
2. **模块重叠告警**：两张没有依赖关系的票改同一批文件。有意的话在票里写明，否则加 `blocked_by`。
3. 触碰保护路径（契约、`.github/**`）的票有没有写 `protected_paths_ok`。
4. 依赖图没有环、没有多余的串行。

确认没问题，在**规划仓库**里 confirm（to-tickets 问「开工吗？」你答「是」时，它就在规划仓库里跑这一条）：

```sh
plat spec confirm S-n       # 从这一刻起开始实现
```

- 它把规划文档（`GLOSSARY.md`、`docs/adr/`、`AGENTS.md`；多上下文的仓库还有 `GLOSSARY-MAP.md` 和它列出的各上下文下的 `GLOSSARY.md`、`docs/adr/`）相对远端默认分支的改动——提交了没推送的、没提交的都算——作为补丁发给平台（在 `afk/setup` 工作树里时，相对远端的 `afk/setup`，补丁里只有规划文档的改动）。平台收下后，plat 把这些路径上没提交的改动从 checkout 里收走：新建的删掉，改过的还原成 HEAD 的样子，不用 stash；补丁备份在仓库外的 `~/.afk/planning/S-n/`。这样 PR 合并后 `git pull` 不会和它冲突。你已经提交的、以及规划文档以外的改动，一律不动；confirm 被拒时什么都不收走。需求合入或取消后，下一条 plat 命令会顺手删掉这个备份目录。
- 平台先做**规划提交**：把补丁三方合并到规划仓库的设置提交（没有 `afk/setup` 要叠时就是默认分支的最新提交）上，作为集成分支的开头；做好之前一张票都不开工。规划仓库里没有这个需求的票时，收尾会给它单独开一个只有文档的 PR。
- 在页面上确认、或在规划仓库以外的地方 confirm，带不上本地的规划文档（预检标黄）；规划提交就是默认分支当时的最新提交。在项目的另一个仓库里 confirm 会被拒绝。
- 补丁超过 1 MB 会被拒绝：规划文档只该有上面这些。

### 第 5 步 等待和验收

- 页面 `http://127.0.0.1:5173` 先看工作台（等你处理 / 正在运行 / 等你验收 / 最近完成）；终端里 `plat spec show S-n`。票卡住时本机也会发一条 macOS 通知（点开打不开页面，去待处理或通知里的链接）。
- 全部票 done 后平台做整体 review 和修复，然后开 PR（`spec/<id>/<slug>` → `main`），并生成验收包（`plat spec show S-n` 里能看）。
- **你**读验收包，在 GitHub 上看 diff、合并 PR。合并后平台自动清理分支，spec 变 `merged`。

## 3. 场景 B：前后端各一个

和场景 A 的区别只有四点。

1. **规划在哪里**：skills 仍在后端仓库里跑（契约在这里，tracker 文档也在这里）。后端 agent 看不到前端代码，所以：grill 时把前端的目录结构、技术栈、API client 的生成方式讲给它，或者把前端仓库也加进同一个 agent 工作区（Cursor 多根工作区 / Claude Code 的 `--add-dir`）让它能读——这是我的建议，仓库文档没有明说，你试一下哪种可用。`to-spec` 里要把**共享的名字、字段、接口形状**写死，否则前后端会各起各的名。
2. **票的写法**（附录 B，照 `docs/specs/m2-acceptance/tickets/`）：

   ```
   contract(后端) ──blocks──► be-impl(后端) ──────────┐
        │                                              ▼
        └──contract（跨仓库）──► fe-impl(前端) ─────► e2e(前端, environment:[后端])
   ```

   - 契约票 `type: contract`，只改契约文件，必须写 `protected_paths_ok`。
   - 前端票用 `contract: <契约票 key>` 引用契约（**跨仓库的契约边**）：平台把契约合并时的版本（契约 SHA）送给前端 agent。
   - 前端若还想只读参考后端代码，加 `refs: [backend]`。
   - 联调票 `type: integration`，写在使用方（前端）仓库，`environment: [backend]`，`blocked_by` 两边的实现票。
3. **联调**：联调票合并后，平台会在全新的联调环境里跑 `npm run e2e`；失败时 agent 诊断出错的仓库，平台**自动**建修复票，修好后重跑，最多 2 轮，之后 blocked（`integration-loop-exceeded`，或 `integration-unknown-side`）。
4. **合并顺序**：PR 会同时开，但**用别人契约的仓库（前端）的 PR 先开成 draft**。你先合并后端 PR，平台看到后自动把前端 PR 转 ready，你再合并前端。`plat spec show` 按合并顺序列出各 PR、draft/ready 和在等什么。状态从 `partially-merged` 到 `merged`。

   > 转 ready 失败（GitHub 权限不够）时会进 `plat blocked`，你在 GitHub 上手动转 ready，下一轮检查自会记下。

## 4. 亲自走一遍：演练清单

按下面的顺序做。**每一步都要看到预期结果才往下走。**

| # | 做什么 | 预期 |
| --- | --- | --- |
| 1 | `scripts/up.sh --check`，然后 `scripts/up.sh` | 全部 `[ok]`；API 和页面起来；页面能打开 |
| 2 | 1.2 在 Cursor 里 `/afk-setup`（场景 B 工作区里放前后端两个仓库） | 清单里各仓库的名字、地址、契约路径都对；每个仓库「the GitHub App can work here」；`plat repo check` 都通过 |
| 3 | 确认 `/afk-setup` 推了各仓库的 `afk/setup`、没有开 PR | 各仓库 GitHub 上有 `afk/setup` 分支，里面有 `.sandcastle/gates.yaml`、`AGENTS.md`，规划仓库还有 `docs/agents/issue-tracker.md`；默认分支没变 |
| 4 | **场景 A**，选一个小需求（一个字段、一个接口） | 见下 |
| 5 | **场景 B**，选一个前后端各改一点的小需求 | 见下 |

**场景 A 的通过标准**

- `/to-spec` 发布后 `plat spec show S-n` 能看到 spec；导入后看到全部票和依赖边。
- confirm 后，页面上第一批没有依赖的票开始跑，不需要你干预。
- 每张票最终 `done`；开出 PR；验收包里验收标准大多数是 `verified`。
- 你合并 PR 后 spec 变 `merged`。

**场景 B 的额外标准**

- 前端票拿到了契约（`/context/contract/...`），契约副本检查通过。
- 联调票的 e2e 通过（或失败后自动建修复票并修好）。
- 前端 PR 先是 draft，后端合并后变 ready，前端合并后 spec 变 `merged`。

**演练的两个提醒**

- 演练会在目标仓库上开**真实 PR**。想看到「开 PR 之前」就停：在票全部 done、还没收尾前 `plat spec cancel S-n`。已有 PR 被合并的 spec 取消不了。
- 演练中遇到真实的 blocked，就按第 6 节处理一次；一次都没遇到，也先读一遍 `plat blocked` 的输出，知道它长什么样。

**演练全部通过后再正式使用。** 正式使用前再确认一次第 7 节的清单。

## 5. 看进度

| 想知道 | 命令 |
| --- | --- |
| 一个 spec 的全貌（票、状态、PR、验收包） | `plat spec show S-n` |
| 一张票的内容 | `plat ticket view T-n`（旧版本：`--version 1`） |
| **有什么在等我** | `plat blocked`（blocked 的票和原因简报、paused 的 spec、被关掉或读不出的 PR、清理没做完的） |
| 某次 run 的日志 | `plat run logs R-n` |
| 图形化 | 页面 `http://127.0.0.1:5173`：工作台、需求（流程条和五个嵌套页）、待处理、独立 Run |

日志目录：API 的 run 日志在 `~/.afk/logs/<实例 id>/`；worker 的沙箱原始日志在 `~/.afk/sandbox-logs/`（含未脱敏的流，别拿去分享）。

## 6. 处理卡住的情况

先 `plat blocked`，看原因，再选动作：

| 情况 | 做法 |
| --- | --- |
| 票 blocked，想让它再试一次 | `plat ticket retry T-n`（`--mode continue` 接着做 / `--mode restart` 重来；可选 `--note "…"` 只对下一次 Run 有效）。页面待处理和票页也能写这句说明再重试。 |
| 门禁发现改了保护路径，且你同意 | `plat ticket approve-protected T-n`，再 retry |
| 票需要改某个保护路径但文件里没批准 | `plat ticket allow-path T-n <路径>`，再 retry |
| 票的描述有问题 | `plat ticket view T-n --md > t.md`，改完 `plat ticket edit T-n --file t.md`（只对 pending / blocked 的票，可改标题、正文、模块、已批准的保护路径，验收标准从正文重新解析；改仓库、类型、依赖要取消后追加） |
| 漏了票或要拆票 | `plat tickets import S-n <目录> --append`（立即生效，可用 `T-n` 引用已有票）；拆票时再 `plat ticket cancel T-n` 旧票 |
| 不要这张票了 | `plat ticket cancel T-n`（`--cascade` 一并取消下游） |
| spec 暂停（超出 agent 时长） | `plat spec resume S-n`（可给更多时间） |
| 规划文档合不进默认分支（别人刚改了同一段），或规划提交连续三次没做成 | 在规划仓库里拉最新的默认分支，运行 `plat spec retry-planning S-n`：它用备份把规划文档三方合并放回 checkout，冲突标在文件里；解决后再运行一次同一条命令，重新发送并再次收走；不要这些文档了：`plat spec waive-planning S-n`（照常开工，验收包和 PR 描述注明「规划文档未提交」；备份一并删掉） |
| 整体 review 步骤 blocked | `plat spec retry-final S-n`（也可带 `--note`，出现在这批收尾 Run 上）；联调失败又确认可以放行：`plat spec waive-final S-n`（验收包会注明） |
| PR 被关掉没合并 | 在 GitHub 上重开；或重做 spec；或 `plat spec cancel S-n` |
| 取消了但分支/PR 没清干净 | `plat spec cleanup S-n` |
| 整个 spec 不要了 | `plat spec cancel S-n`（没做完的票和作业停掉，随后关 PR、删分支） |

## 7. 正式使用前的清单

- [ ] 场景 A、场景 B 各完整走通一次，PR 都合并过。
- [ ] 目标仓库都满足 1.3 的条件（尤其是 `gates.yaml`、`AGENTS.md`、GitHub App 权限）。
- [ ] 规划仓库里的 `docs/agents/issue-tracker.md` 已在 `main` 上（平台或项目配置变了，`plat` 会提示，再跑一次 `/afk-setup`）。
- [ ] 你知道怎么看 `plat blocked` 并处理（第 6 节练过一次）。
- [ ] 清楚平台当前的边界：**没有认证**，只监听 127.0.0.1；只有一个 worker，同时只跑一个需求；PR 评论返工、页面上追加票/改依赖、多个需求并行都还没有。pending / blocked 的票可以在页面上改正文、带说明重试。
- [ ] **升级平台前先确认没有在跑的作业**（`plat blocked` 和页面上都没有 running 的票）：迁移随重启执行，没跑完的作业重跑时，前后阶段可能读到两种拼法的票正文。
- [ ] 停机方式：Ctrl-C；正在跑的 run 会在 worker 租约到期后重新派发，不会丢。

## 8. 常见问题

| 现象 | 原因和处理 |
| --- | --- |
| `up.sh` 说端口已被占用 | 旧的栈还在跑；先停掉旧的，不要同时跑两套（会出现两个 worker 抢同一批槽位） |
| `up.sh` 说缺 `AFK_MODEL` / key | 在终端里运行它会引导补齐；设置保存在 `~/.afk/env` |
| `plat spec create` 报 slug 错 | 中文标题要加 `--slug english-slug` |
| 导入报 YAML 解析错 | 含 `: ` 或以特殊字符开头的 `title`、`acceptance` 整行加引号；全部加引号最稳 |
| 导入被拒：没有契约路径 | `plat repo edit <名字> --project <P> --contract-path openapi/openapi.yaml` |
| 导入报 spec 不是 draft | 一个 spec 只能导入一次；追加用 `--append` |
| agent 卡在提问 | 说明 spec 里的 seams 没写清；在 spec 里补，或改票的 `body` |
| 升级后 `pnpm db:migrate` 失败，写着某张票 `cannot be migrated` | 迁移把所有票的正文改写成 issue 模板（Parent / What to build / Acceptance criteria），并核对验收标准能原样解析回来；不能的票会让整个迁移回滚，错误里写明是哪张票和哪个版本。按提示改那张票的旧正文或验收标准（不要有 `## Acceptance criteria`、`## Parent`、`## Blocked by` 小节，代码围栏要成对），再迁移一次 |
| 前后端起了不同的名字 / 并行改了同一文件 | to-spec 里把共享名字写死；to-tickets 给会改同一文件的票加依赖边 |
| 转 ready 失败 | GitHub App 缺 `contents: write`；手动转 ready |

## 9. 升级 skills SHA

平台从 mattpocock/skills 取的东西都原样复制在本仓库里，是唯一来源，运行时不再需要 Matt 仓库的 checkout：

| 位置 | 内容 | 谁用 |
| --- | --- | --- |
| `skills/` | grill-with-docs、grilling、domain-modeling、to-spec、to-tickets | 规划机器，和 afk-setup 一起用 `npx skills@latest add xxh171015/afk-platform` 装 |
| `packages/pipeline/skills/` | implement、tdd、code-review、codebase-design | worker 只读挂进沙箱 |
| `packages/shared/skills-snapshot/` | setup-matt-pocock-skills 的种子模板 | `plat init`、`plat tracker-doc` |

固定的 SHA 只写在 `packages/shared/src/skills-sha.ts`（常量 `SKILLS_SHA`），每个目录的 `VENDORED.md` 记下复制时的 SHA，守卫测试保证两者一致。升级时在**一个提交**里做完下面几步：

1. 把 `SKILLS_SHA` 改成新的 commit（在 mattpocock/skills 的 checkout 里 `git fetch` 后确认它存在）。
2. 跑刷新脚本：`node scripts/refresh-skills-snapshot.ts <skills checkout 路径>`。它从那个 commit 把上表三处整个重写（附上游 LICENSE 和 `VENDORED.md`）。对当前 SHA 重跑，什么都不会变。
3. 看这三处的 `git diff`：matt 改了什么；按需要改覆盖层引用的步骤和 tracker 文档模板。
4. 改覆盖层声明的 SHA，让它和新常量一致。
5. `pnpm check`：`VENDORED.md` 的 SHA 和常量不一致、提示词引用的 skill 没在挂载目录里时，守卫测试会失败。

合并后，worker 重启就用上新 skill（`scripts/up.sh` 重启即可）。规划机器上运行 `plat update` 更新（`plat` 也会提示）。

## 附录 A：场景 A 的票目录

票是一个目录，一张票一个 `.md` 文件，文件名（去掉 `.md`）就是票的 key。front matter 放标题和平台字段，后面是 to-tickets 的 issue 模板原文；验收标准只从 `## Acceptance criteria` 读，不另写。`## Parent` 写要导入的 spec。下面用 spec `S-1`。

**`contract.md`**

```markdown
---
title: "契约：订单备注字段"
repo: backend                 # 1.2 登记的仓库名（plat init 的清单里有）
type: contract
modules: ["openapi/**"]
protected_paths_ok: ["openapi/openapi.yaml"]
---

## Parent

S-1

## What to build

只改契约，不改代码。

## Acceptance criteria

- [ ] openapi.yaml 的 Order 里有可选字符串字段 note，最长 200 个字符
```

**`note-field.md`**

```markdown
---
title: "订单增加备注字段"
repo: backend
type: implementation
modules: ["src/orders/**", "test/**"]
blocked_by: [contract]
contract: contract            # 可选：拿到契约票合并时的版本
---

## Parent

S-1

## What to build

按契约实现，不要修改契约文件。

## Acceptance criteria

- [ ] POST /orders 接受可选的 note，超长返回 400
- [ ] 每条验收标准都有对应的 HTTP 测试，已有测试不减少、不跳过
```

不改契约的需求可以不要 `contract` 票，直接写 `implementation` 票。

## 附录 B：场景 B 的票目录

前后端两个仓库，spec 是 `S-2`。`refs` 和 `environment` 也写在 front matter 里。

**`contract.md`**

```markdown
---
title: "契约：取消订单必须带原因"
repo: backend
type: contract
modules: ["openapi/**"]
protected_paths_ok: ["openapi/openapi.yaml"]
---

## Parent

S-2

## What to build

只改契约，不改代码。

## Acceptance criteria

- [ ] POST /orders/{id}/status 的请求体增加可选字段 reason（1 到 200 个字符）；status 为 cancelled 时必须带，否则返回 400
```

**`be-cancel-reason.md`**

```markdown
---
title: "后端：取消订单记录原因"
repo: backend
type: implementation
modules: ["src/orders/**", "test/**"]
blocked_by: [contract]
---

## Parent

S-2

## What to build

按契约实现，不要修改契约文件。

## Acceptance criteria

- [ ] 带 { status: "cancelled", reason } 时成功，状态记录带上 reason
- [ ] 取消但没有 reason 时返回 400
```

**`fe-status-actions.md`**

```markdown
---
title: "前端：订单详情页的取消原因"
repo: frontend
type: implementation
modules: ["src/**", "contract/**"]
contract: contract            # 跨仓库的契约边
refs: [backend]               # 可选：只读参考后端代码，出现在 /refs/backend/
---

## Parent

S-2

## What to build

调后端只用生成的 client，mock 只用 openapi-msw。e2e 由联调票写。

## Acceptance criteria

- [ ] 契约副本 contract/openapi.yaml 更新为这张票的契约，client 重新生成
- [ ] 点「取消」弹出输入框填原因，原因为空时不能提交
```

**`e2e.md`**

```markdown
---
title: "联调：取消原因"
repo: frontend
type: integration
modules: ["e2e/**"]
environment: [backend]        # 不能包含票自己的仓库
blocked_by: [be-cancel-reason, fe-status-actions]
---

## Parent

S-2

## What to build

在联调环境里写 e2e，对着真后端跑通再提交。

## Acceptance criteria

- [ ] e2e：取消订单时填写原因，状态记录显示这个原因
```

**不想要自动联调**时去掉 `e2e.md`，前后端实现票各自完成即可，联调由你在合并前手动验证。

## 附录 C：追加票时指向已有的票

spec confirm 之后用 `plat tickets import S-n <目录> --append` 追加票（见第 6 节）。追加的票文件里：

- 新票的 `blocked_by` 和 `contract` 可以写已有的票 `T-<n>`：新票等它们，或把它们当作契约上游；
- `blocks: [T-<n>]` 让新票去阻塞一张已有的票（只有 `pending` 或 `blocked` 的票可以被阻塞）。这是让新票排在已有票前面的**唯一**写法；
- 但 `blocks` 只能写普通的阻塞边，**contract 边不能指向已有的票**：新的契约票没法写成已有票的契约上游。「契约变更」（contract-change-needed）后追加新的契约票时，让新契约票 `blocks` 那张已阻塞的票，它就会等新契约票合并；已有票读到的契约仍是它原来的契约上游，要换成新契约需要取消它再追加一张新票（`contract: <新契约票的 key>`）。

例子：已有一张被卡住的票 `T-8`，追加一张新的契约票，让 `T-8` 等它。新票的文件：

```markdown
---
title: "契约：补上取消原因的长度限制"
repo: backend
type: contract
modules: ["openapi/**"]
protected_paths_ok: ["openapi/openapi.yaml"]
blocks: [T-8]                 # 只能在 --append 的文件里写
---
```

如果以后要让新契约票成为已有票的契约上游，需要给 front matter 加字段，到时另开票讨论。

## 附录 D：逐条登记和改设置

`plat init` 做的事也可以一条条做，改已登记的设置只能这样做：

```sh
plat project create shop --protected-path ".github/**"     # 打印 project id，下面叫 <P>
plat repo add --project <P> --name backend  --url https://github.com/<owner>/<后端仓库>.git
plat repo edit backend --project <P> --contract-path openapi/openapi.yaml    # 契约属于后端
plat repo add --project <P> --name frontend --url https://github.com/<owner>/<前端仓库>.git
plat tracker-doc --project <P> --repo backend > docs/agents/issue-tracker.md   # 在规划仓库里
```

- **代码托管类型**：`--host-kind github|gitlab`（`plat repo add` 和 `plat repo edit` 都可以）。不写时按地址推断一次（地址里有 `gitlab` 就是 GitLab，否则 GitHub）并存下来；自建 GitLab 的地址不含 `gitlab` 时要显式写 `--host-kind gitlab`。`plat tracker-doc` 按它选 GitHub 或 GitLab 的种子模板。
- 契约路径只设在**出契约的仓库**上。没设就导入含契约票的文件，会被拒绝。
- `--protected-path` 是 agent 默认不能改的路径（再加上契约文件）。要改就在票里写 `protected_paths_ok`。
