# M2 平台：多仓库、契约先行、联调

2026-10-30 · 草稿，待用户确认后发布。依据：[design.md](../design.md)、[m1-platform.md](m1-platform.md)、[GLOSSARY.md](../../GLOSSARY.md)，以及「AFK 研发平台：走到 M2 可交付实现」地图（#62）上各决策票的结论。术语以 GLOSSARY 为准。

## Problem Statement

M1 把单个仓库里的一个需求跑到了「可以由人验收」，但开发者的真实需求大多跨仓库：前端和后端分仓，后端也可能有好几个库，有时还要参考一个这次不改的库。M1 的平台只认一个仓库：契约挂在项目上、只能在同一个仓库里传递；合并顺序、PR、验收包都按单仓库做；没有地方验证前后端合在一起能不能用。需求一旦确认，就没法再往里加票、改票；按旧契约做完的票也没有办法处理。

## Solution

把平台从「一个仓库」推广到「一个项目里任意几个仓库」，并加上联调：

- 仓库只有名字，不分前后端。一个需求可以改项目里任意几个仓库，每张票只往自己的仓库提交，可以只读参考项目里任何仓库在固定 SHA 上的快照。
- 契约属于提供接口的仓库。契约票合并后记下契约 SHA，下游票（可以在别的仓库）只用这个 SHA 上的契约；使用方仓库里提交一份契约副本，平台逐字节核对。
- 联调票在前端（使用方）仓库里写 e2e，平台在联调环境（各仓库的服务按集成分支构建、放进同一个 docker 网络）里跑；跑不通由 agent 诊断出错的仓库，平台自动建修复票，修好后重跑，最多两轮。
- 收尾按仓库并行；PR 一起开，使用契约的仓库的 PR 先开成 draft，等提供契约的仓库合并后由平台转 ready；需求按合并情况经过 `partially-merged` 到 `merged`。
- 需求确认后还能追加票和边（改契约、拆票都靠它），pending / blocked 的票能改；做完的票不重开。

人出现的时机不变：确认拆分、处理 blocked、最后合并。

## User Stories

仓库与契约

1. As a 开发者, I want 用名字登记项目里的每个仓库（`plat repo add --name …`），不分前端后端, so that 一个项目可以有一个前端、好几个后端。
2. As a 开发者, I want 契约挂在提供接口的那个仓库上（每个仓库可有可无）, so that 后端服务之间、前后端之间走同一套契约机制。
3. As a Cursor 里的 agent, I want 导入时 contract 边和 blocks 边都能跨仓库, so that 一个需求可以按「契约票 → 各仓库实现票 → 联调票」拆。
4. As a 开发者, I want 导入时仓库之间的契约关系成环就被拒绝, so that 合并顺序总能算出来。
5. As a 开发者, I want 一张票有多条 contract 入边时用依赖图里最下游那张契约票的 SHA，导入时要求这些上游排成一条链, so that 「最新的契约」由图决定，不看时间先后。
6. As a 使用方仓库里的 agent, I want 在 `/context/contract/<仓库名>/` 读到这张票该用的契约, so that 契约来自哪个仓库一目了然。
7. As a 平台, I want 核对使用方仓库的契约副本和这张票的契约 SHA 上的契约逐字节相同（没有 contract 入边的票不许改副本）, so that 前端不会对着悄悄改过的契约生成 client。

只读参考

8. As a 开发者, I want 在票里写 `refs: [仓库名…]`, so that agent 能读另一个仓库的实现（比如参考另一个后端的写法），但改不了它。
9. As a 平台, I want 参考快照的 SHA 由 API 在每次运行时定（本需求有集成分支用它的 head，没有就用 main），记在 Run 上, so that agent 看到的是什么永远可以追溯。

追加与改票

10. As a 开发者, I want 用 `plat tickets import S-n more.yaml --append` 往一个已确认、还没收尾的需求里加票和边, so that 契约要改、要拆票时不用取消重来。
11. As a 开发者, I want 追加时平台列出「还在用旧契约」的票（pending / blocked 的提示接上新契约，已经开工或做完的提示追加适配票）, so that 我不会漏掉按旧契约做的票。
12. As a 开发者, I want 做完的票保持 done，要改就追加适配票, so that 一张票只对应一段合并历史，追溯和验收包不乱。
13. As a 开发者, I want 用 `plat ticket edit T-n --file t.yaml` 改 pending 或 blocked 的票的内容，版本号加一、每版留快照, so that 改票后重试有据可查。
14. As a 开发者, I want 报 `contract-change-needed` 的票在我追加新契约票后仍停在 blocked、由我决定怎么重试, so that 平台不替我做选择。

联调

15. As a 开发者, I want 联调票声明 `environment: [仓库名…]`，平台把这些仓库的服务按本需求的集成分支（没有就用 main）构建、放进同一个网络, so that e2e 对着的是这次要合并的代码。
16. As a 联调票的 agent, I want 在联调环境里写 e2e、对着真服务跑通再提交, so that e2e 不是闭着眼写的。
17. As a 平台, I want 联调票合并后由 worker 自己在全新的环境里跑 e2e、以 JUnit 为准, so that 「联调通过」是平台验证过的事实，不是 agent 的说法。
18. As a 平台, I want e2e 失败时让 agent 在同一个环境里诊断出出错的仓库（`failingRepo`），只诊断不改代码, so that 修复票建在对的仓库。
19. As a 平台, I want 自动在出错的仓库建修复票、挡在联调票前面，修好后联调票直接从 e2e 重跑, so that 联调失败不需要人介入。
20. As a 开发者, I want 联调最多修两轮，判断不出哪边错、或者环境起不来时进 blocked 并附证据, so that 循环有上限。
21. As a 开发者, I want 联调的每次运行记下环境里各仓库的 SHA、测试数和起环境的耗时, so that 我能复盘联调到底测了哪些代码。

收尾、PR 与合并

22. As a 平台, I want 全部票（含联调票）done 后各仓库并行收尾, so that 和 M1 一样每个仓库有一次整体 review 和一次修复。
23. As a 平台, I want 有仓库跑了 final-fix 时，开 PR 前每张联调票再跑一次 e2e, so that 总览修复没有把联调验证过的东西改坏。
24. As a 开发者, I want 开 PR 前的那次联调失败时选「重试」或「放行」, so that 最终合不合仍由我决定，失败的事实摆在验收包最显眼的地方。
25. As a 开发者, I want 使用契约的仓库的 PR 先开成 draft，提供契约的仓库合并后平台自动转 ready, so that GitHub 上就体现了合并顺序。
26. As a 开发者, I want 需求按 PR 合并情况进入 `partially-merged`、`merged`, so that 记录和代码托管一致。
27. As a 开发者, I want 打破合并顺序时平台只记录不阻止, so that 特殊情况下我仍能先合别的。
28. As a 开发者, I want 部分 PR 已合并、其余都已关闭的需求能取消, so that 它不会永远卡在 `partially-merged`。
29. As a 开发者, I want 验收包按仓库分节、开头写合并顺序、联调单独一节，验收标准的测试取这张票所有 implement 和 fix 运行, so that 我看完就知道每个仓库合不合。

## Implementation Decisions

### 仓库模型（「跨仓库的上下文」#68）

- `repos.role` 正名为仓库名（项目内唯一，导入文件里 `repo:`、`refs:`、`environment:` 都写它）。现有的 `backend`、`frontend` 原样当名字，不迁移数据。`plat repo add --name …`；`--role` 保留为别名一个版本。
- 契约路径从 `projects.contract_path` 挪到 `repos.contract_path`（每个仓库可空）。迁移把项目上的值（`<role>:<path>`）搬到对应仓库上，然后删掉项目上的列；`plat project edit --contract-path` 改为 `plat repo edit <名字> --contract-path`。
- worker 的主 clone 按仓库名存放（现在是 `<role>.git`，名字没变的仓库不用挪）。
- M2 不按仓库区分能力标签：一台 worker，GitHub App 装在所有试点仓库上。

### 导入校验（追加时同样适用）

在 M1 的四条之上：

- contract 边、blocks 边都可以跨仓库；满足条件不变（blocker done；contract 边还要记下契约 SHA）。contract 边的上游必须是它仓库里有契约路径的契约票。
- 一张票的所有 contract 上游，在同一个仓库里必须排成一条链（同一仓库有两张契约票时，后一张要显式写 `blocked_by` 前一张）。
- 由 contract 边推出的仓库关系（X 的契约被 Y 使用）不能成环。
- `refs:`、`environment:` 里的名字必须是项目里的仓库；`environment:` 只能写在 `integration` 类型的票上，且不能包含票自己的仓库。
- `external_blocked_by` 仍须为空。

### 追加与改票（「契约变更与改票」#65）

- **追加**：`plat tickets import S-n more.yaml --append`，spec 是 planned / running / paused 时可用（draft 用普通导入；finalizing 及以后拒绝）。文件里可以用 `T-n` 引用已有票。追加文件另有顶层 `edges: [{ from, to, kind }]`（`kind` 默认 `blocks`，两端写本文件的 key 或 `T-n`），用来写「新票 → 已有票」的边，因为 `blocked_by` / `contract` 只能写在被挡的那张票上；普通导入不接受 `edges`。全套校验在合并后的整张图上做（只算没取消的票）。**立即生效，不再确认拆分**，告警在命令输出里。
  - 每条新边至少一端是新票；已有票 → 新票：已有票不是 cancelled 即可（done 的当场算满足）；新票 → 已有票：被挡的已有票必须是 pending 或 blocked。
  - 「拆票」= 追加新票 + `plat ticket cancel` 原票。
- **done 是终态，不重开**。追加了契约票时，平台找出同一仓库旧契约票的 contract 下游里、这次没接到新契约票下的票：pending / blocked 的提示「会继续用旧契约，是否接上新契约票」；queued / running / merging / done 的提示「已经或正在按旧契约做，考虑追加适配票」。适配票就是普通的实现票。
- 报 `contract-change-needed` 的票，追加给它接上新契约票后仍停在 blocked；人重试后它回到 pending，等新契约 SHA 出来才可开工。追加不顺带重试。
- **改票**：`plat ticket edit T-n --file t.yaml`（格式同导入文件里的一张票）。可改标题、正文、验收标准、模块、已批准的保护路径；不可改仓库、类型、依赖边、`refs`、`environment`（要改就取消 + 追加）。只能改 pending / blocked 的票；内容版本号加一，票保持原状态；新表 `ticket_versions` 存每个版本的完整快照；`plat ticket view T-n --version n` 看旧版。
- 只做 `plat`；页面只读：显示内容版本、追加进来的票和边、追加时的告警。

### 跨仓库的上下文（#68）

- bundle 新增 `contracts: [{ repo, url, defaultBranch, sha, path }]`（`url`、`defaultBranch` 让 worker 能 clone 提供契约的仓库）（按仓库，每个仓库取图里最下游契约票的 SHA；取代 M1 的 `LIMIT 1`）和 `refs: [{ name, sha }]`。Run 新增 `contract_shas`（按仓库）和 `ref_shas`。
- worker 渲染 `/context/contract/<仓库名>/<文件名>`：在提供契约的仓库的主 clone 里 `git show <SHA>:<路径>`，本地没有就先 clone / fetch。
- **契约副本检查**：使用方仓库提交 `contract/openapi.yaml`（多个上游时 `contract/<仓库名>/openapi.yaml`）。worker 在保护路径检查同一步，逐字节比对副本和这张票该用的契约；没有 contract 入边的票不许改副本。违反 → blocked，新原因码 **`contract-copy-mismatch`**。副本和生成物不进保护路径（由这道检查和门禁里的 `--check` 管住）。门禁沙箱不挂契约。
- **只读快照** `/refs/<仓库名>/`：SHA 由 API 在每次 agent 运行（implement、各种 fix、review）生成 bundle 时定（本 spec 有集成分支用它的 head，没有用 main）。API 没有 git 和代码托管的访问，所以 bundle 的 `refs: [{ name, url, defaultBranch, sha }]` 里 `sha` 取该仓库在本 spec 里最近一次合并后的集成分支 head，没有合并过则为 null，由 worker 取默认分支的 head；worker 把实际用的 SHA 记在 Run 上（`ref_shas`）。`git archive <SHA>` 解到临时目录再 `rename` 到 `~/.afk/snapshots/<仓库名>@<SHA>`，同 SHA 共用；导出前在主 clone 的 `info/attributes` 写 `* -export-ignore -export-subst`；不导出子模块、不展开 LFS（已知限制）；Node 里分别检查 `git archive` 和 `tar` 的退出码；worker 启动时删掉 7 天没用过的快照。

### 联调（「联调票与修复票的模型」#71、「联调环境原型在 Mac 上跑通」#70）

**联调票的流水线**：

```
implement（agent，在联调环境里写 e2e 并提交）→ 门禁（本仓库门禁，不含 e2e）→ review → merge
  → e2e（worker 确定性步骤：新起联调环境，全新沙箱跑 npm run e2e，读 JUnit）
      全过 → done
      有失败 → diagnose（agent，同一个环境，只诊断不提交）→ 修复票
```

- 写 e2e 时发现别的仓库有问题：照验收标准写，不迁就错误行为，照常提交并输出 `done`，在 `uncertainties` 里写明怀疑哪个仓库。
- e2e 在 merge 之后跑，用的是环境里各仓库集成分支的 head，所以修复票合并后重跑就带上了修复。
- **diagnose** 用 `afk-integration.md` prompt，结构化输出 `result`（pass / fail）、`failingRepo`（e2e 所在仓库、`environment` 里的仓库之一，或 `"unknown"`；pass 时为 null）、`evidence`、`failingTests`。
- **修复票**由平台自动建，不需要人确认：在 `failingRepo` 的仓库、同一个 spec，类型 `fix`；正文是诊断的证据和失败用例加联调票的验收标准；验收标准「联调票 T-x 的 e2e 通过」加诊断指出的问题；模块 `**`（不做重叠告警）；修复票 blocks 联调票；走普通流水线。联调票回到 pending，修复票 done 后它重新可开工，**从 e2e 阶段开始**。
- **轮数**：一次 e2e 失败加随后的修复票算一轮，记在联调票上，最多 2 轮；第 3 次 e2e 失败 → blocked `integration-loop-exceeded`。`failingRepo: unknown` → 直接 blocked，新原因码 **`integration-unknown-side`**。环境起不来（构建失败、健康检查不过、服务名冲突）照 M1 作业失败规则重排，同阶段三次失败 → blocked，新原因码 **`integration-environment-failed`**，简报附 build / compose 日志尾部，不建修复票。人可以：重新跑 e2e（轮数清零）、追加修复票后重试、取消。
- **记录**：e2e 和 diagnose 的 Run 记环境里每个仓库的 SHA、e2e 所在仓库的 SHA、JUnit 的测试总数和失败数、起环境的耗时。e2e 结果存成一条 GateResult（commit 为 e2e 所在仓库的 SHA），验收包读它。

**联调环境**：

- 联调票的 `environment:` 列出的仓库，每个提供一个 compose 片段 `.sandcastle/integration/compose.yaml`。worker 给每个仓库打快照（同上的 SHA 规则），片段里带 `build:` 的服务在它自己仓库的快照里 **`docker build --pull=false`**，镜像名 `afk-<run-id>-<服务名>`；然后 `docker compose -p afk-<run-id> -f 片段1 -f 片段2 … up --no-build -d --wait`。不用 `compose build`（它会去远端解析基础镜像，Mac 上连不上 Docker Hub）。
- 一次性的数据准备服务一律叫 `seed-<仓库名>`，环境起来后按 `environment:` 的顺序逐个 `compose run --rm`。服务名在所有片段之间必须唯一。
- 实现时定下的约定：`up` 只列出非 `seed-` 的服务（种子服务只用 `run` 跑）；仓库没有 `seed-<仓库名>` 服务就跳过；带 `build:` 的服务不能同时写 `image:`（镜像名固定是 `afk-<run-id>-<服务名>`，也就是 compose 给没写 `image:` 的服务取的名字）；`build.context` 和 `dockerfile` 相对片段所在目录。沙箱里要用的服务地址写在片段顶层的 `x-afk-env:`（compose 会忽略 `x-` 开头的键），例如 `BACKEND_URL: http://backend:8080`，各片段合并后整体通过 `docker({ env })` 传入，同名不同值报错。
- e2e 命令是 `npm run e2e`（前置命令用仓库 `gates.yaml` 的 `setup`），JUnit 写在 `reports/e2e-junit.xml`；命令退出码非 0 时也读这份报告（测试框架在有失败时照样写报告）。有失败用例，或报告里没有用例，都算 e2e 失败。
- e2e 失败时票先进 blocked，原因码暂用 `post-merge-gate-failed`，失败用例在 Run 的输出里；诊断和修复票做完后换成专门的原因码。
- 网络按 compose 的 label 找（`com.docker.compose.project=afk-<run-id>` + `com.docker.compose.network=default`），不拼名字；建沙箱前确认网络存在（网络不存在时 Sandcastle 会留下一个 `Created` 状态的孤儿容器）。默认网络不能设成 `internal`（沙箱要经它访问模型 API）。
- 沙箱：联调票所在仓库的镜像（agent 运行、门禁、联调共用），`docker({ network, env })`，服务地址通过 `env` 传（试点前端是 `BACKEND_URL`），`/context` 和 `/refs/*` 只读挂载。
- **清理**：先结束沙箱，再 `compose down -v`，再按 label 查一次网络，还在就再 down 一次（沙箱还挂着时 `compose down` 返回 0 但网络会留下）；删掉 `afk-<run-id>-*` 镜像。worker 回收孤儿容器从 `docker ps -q` 改为 `docker ps -a`（包括 `Created`）；worker 被杀后，下一个作业按 compose 项目名 `afk-<run-id>` 找回并 down 掉它的环境。

### 收尾、PR 与合并（「多仓库的收尾与合并顺序」#66，合并顺序按 #68 改）

- 收尾时机不变：整个 spec 的票（含联调票）全部 done 后，各仓库并行收尾（`final-review` / `final-fix` / `final-merge`）。
- **开 PR 前的重跑联调**：所有仓库收尾完成、且有仓库跑过 final-fix 时，作为收尾里的 spec 级步骤（不属于任何票），每张联调票各跑一次 e2e 阶段，用收尾后各集成分支的 head。失败也跑一次 diagnose（只为给简报证据，不建修复票），spec 的收尾 blocked；人选**重试**或**放行**（照常开 PR，验收包最显眼处写「开 PR 前的联调失败」并附证据），也可以取消 spec。spec 里没有联调票时不跑。
- **合并顺序由 contract 边推出**：本 spec 里有 contract 边从仓库 X 的票连到仓库 Y 的票，X 的 PR 先合；Y 的 PR 开成 draft。没有契约关系的仓库之间没有顺序，不开 draft。PR 仍然所有仓库一起开。
- **`pr-ready`**：新的 host 作业。host-sync 发现某仓库的 PR 已合并，就给依赖它、还是 draft 的 PR 各排一个 `pr-ready`，由带凭据的 worker 把 draft 转 ready（预计 Pull requests 写权限够用，实现时实测）。失败隔 60 秒重试，三次失败进 `plat blocked`；人手动转了 ready，host-sync 看到不是 draft 就算完成。
- **Spec 状态**：awaiting-review 时至少一个、但不是全部 PR 合并 → `partially-merged`；全部合并 → `merged` → `spec-cleanup`。清理只在终态时对所有仓库一起做。
- **打破合并顺序**（先合了还在等待的仓库）：spec 上标「合并顺序被打破」，显示在 `plat spec show`、页面和验收包，状态照常推进，不进 `plat blocked`。
- **异常**：提供契约的仓库的 PR 关闭未合并时，其余 PR 保持 draft，照 M1 进 `plat blocked`，人重开 PR 或取消 spec。**取消规则改为**「有 PR 已合并、又还有开着的 PR 时不能取消」：`partially-merged` 且其余 PR 都已关闭的 spec 可以取消，已合并的部分留在 main 上，随后清理。
- **验收包**：每个 spec 一份；开头写合并顺序，按仓库分节，联调单独一节（有重跑就写重跑的结果）。每条验收标准用它那张票所在仓库的门禁 JUnit 核验，联调票的标准用 e2e 的 GateResult 核验。测试名取这张票所有 implement 和 fix 运行的输出（每条标准以最后一次为准）；列出已取消的票（标「已取消」）和追加进来的票（标「追加」）；仍然只生成一次。

### 状态机与原因码

- Spec：实现 `awaiting-review → partially-merged → merged` 的流转；`reworking` 仍只有枚举。
- Ticket：联调票的 merge 之后多出 e2e / diagnose 两个阶段；修复票建成后联调票 `→ pending`（等待修复票），修复票 done 后它从 e2e 阶段开始。阶段仍记在 Run 上，不加票的状态。
- 新原因码：`contract-copy-mismatch`、`integration-unknown-side`、`integration-environment-failed`（`integration-loop-exceeded` 已在 design.md）。
- 新作业：`pr-ready`（host）；新阶段：`integration-implement`（在环境里的 implement）、`e2e`、`diagnose`；收尾里新增 spec 级的 `final-e2e`。

### 并发与预算默认值（都放项目配置）

- 联调票的 implement、e2e、diagnose 各占一个槽位。
- **每台 worker 同一时刻最多 1 个联调环境**（`maxIntegrationEnvironments`）。
- 环境的服务不向宿主机暴露端口，只在 compose 网络里访问，不会有端口冲突。PoC 不给容器设内存上限。
- e2e 阶段是确定性步骤，不计入 agent 时间预算，单设墙钟上限 15 分钟；diagnose 和环境里的 implement 照常计入。
- 其余照 M1。

### 页面

在 M1 的四个视图上加：内容版本和改票历史、追加进来的票和边、追加告警；依赖图跨仓库（节点标仓库名）；需求详情显示每个仓库的 PR、draft / ready、合并顺序和是否被打破、`partially-merged`；票详情显示联调运行（环境 SHA、e2e 结果、诊断）。仍然以读为主。

### 试点仓库

- 后端 `afk-pilot-backend`、前端 `afk-pilot-frontend`（「新建前端试点仓库并接入平台」#69 已就绪）。M2 验收在**新库**里登记，仓库名就用 `afk-pilot-backend`、`afk-pilot-frontend`；后端片段里的 `seed` 要改名为 `seed-afk-pilot-backend`（随实现一起改）。
- 前端：openapi-typescript + openapi-fetch、MSW 3 + openapi-msw、vitest + jsdom + Testing Library、Playwright（只用 Chromium，只在联调时跑）；门禁 `typecheck → contract（--check）→ test → build`，基线 8 个测试。
- 后端：openapi-backend 契约测试，门禁先跑 `contract`（`validate-api`，OpenAPI 3.1 元 schema），基线 90 个测试。已知缺口：openapi-backend 用 draft-07 的 Ajv，2020-12 才有的关键字不校验。
- 后端仍是内存存储：「compose 里带数据库 / 缓存」这种形态本期验证不到。

## Testing Decisions

照 M1 的三层，尽量用最高的一层：

1. **API 层**（HTTP + 真 Postgres）：仓库名与契约迁移；导入和追加的校验（跨仓库的边、契约链、仓库间成环、`refs` / `environment`）；追加告警；改票和版本；多契约取 SHA；合并顺序、draft、`pr-ready`、`partially-merged`、新的取消规则；修复票的建立、轮数、三个新原因码；`final-e2e`。**多后端仓库的情况（不建第二个后端试点）在这一层覆盖**：三个仓库、两条契约关系的合并顺序，按名字的 `refs`，成环拒绝。
2. **pipeline 层**（临时 git 仓库，假的 agent 运行器）：契约副本检查；快照（含 `info/attributes` 覆盖）；按仓库渲染 `/context/contract/`；compose 片段的合并、服务名冲突、`seed-*` 顺序（用假的 docker 命令执行器，Docker 本身留给演练）。
3. **端到端（不进自动化）**：真 Cursor、真 Docker：验收需求和演练。

先例：原型分支 `prototype/m2-integration` 的 `m2/proto.ts` 已经在 Mac 上跑通了联调环境的全部 Docker 步骤，可以照着写 worker 的那部分。

## Out of Scope

- 一个仓库依赖另一个仓库**未发布的包**（共享库发版、在集成分支之间流转）。
- PR 评论返工 `rework`、`update-branch`、`trial-merge`、多个需求并行、跨需求的依赖边（M3 / M4）。
- 按仓库区分的 worker 能力标签、多 worker、公司服务器、GitLab、MinIO（M3）。
- `plat context`、bug 类型 spec、追溯反查（M4）；事件与插件、信任阶梯、登录与权限（M5）。
- 页面上编辑票、追加票、改依赖；通知。
- Cursor 的 token 用量与成本统计。
- 容器内存上限和其他加固。

## Further Notes

### 建议的实现顺序（供 to-tickets 参考）

1. 仓库按名字区分、契约挪到仓库上（迁移 + `plat repo add --name` / `plat repo edit`）；导入校验放开跨仓库的边，加 `refs:`、`environment:`、契约链和仓库间成环的校验。
2. 追加导入（`--append`、告警）、`ticket edit` 与 `ticket_versions`；Run 记 `contract_shas`。
3. 跨仓库的上下文：bundle 的 `contracts` / `refs`，worker 按仓库渲染 `/context/contract/`、做快照、挂 `/refs`，契约副本检查。
4. 合并顺序、draft、`pr-ready`、`partially-merged`、新的取消规则。
5. 验收包按仓库分节、测试取所有运行、列出取消和追加的票。
6. worker 的联调环境：快照、`docker build`、片段合并、`compose up --no-build`、按 label 找网络、清理、孤儿回收（`ps -a`）。
7. 联调票的流水线：环境里的 implement、e2e、diagnose、修复票、轮数、三个新原因码。
8. 开 PR 前的重跑联调（`final-e2e`）、重试 / 放行。
9. 页面跟上。
10. 演练和验收。

第 1 步之后的都依赖新的仓库模型；第 6 步可以和第 2–5 步并行；第 7、8 步依赖第 6 步。

### 前置

没有只有人能做的前置步骤：GitHub App 已装在两个试点仓库上（#69 实测能换到两个仓库的令牌）。Mac 上的 Docker 拉不到 Docker Hub，基础镜像已从 `public.ecr.aws` 拉下并打好本地标签 `node:22-bookworm`、`node:22-bookworm-slim`。

### 验收需求

在两个试点仓库上跑一个 4 张票的需求「订单状态操作与取消原因」，见 [m2-acceptance/](m2-acceptance/)。

**通过标准**：

- 4 张票从导入到两个 PR 开出，人只在确认拆分和最后合并时出现；
- 契约票合并后记下契约 SHA，前端票拿到它，前端的契约副本检查通过；
- 前端 PR 先开成 draft，后端 PR 合并后由平台转 ready；spec 经过 `partially-merged` 到 `merged`；
- 联调票的 e2e 以 JUnit 为准通过，记录了环境里各仓库的 SHA；
- 验收包按仓库分节、有联调一节；
- 全程每次运行可追溯（Run、日志、GateResult、trailer）。

修复票的循环如果自然触发并处理成功最好；没有触发也算通过，由 API 层的测试和下面的演练覆盖。

### 中断演练清单（手动，在 Mac 上用真实 Cursor）

- [ ] 在联调票的 implement 运行中杀掉 worker：沙箱和 compose 环境都被回收（按 `afk-<run-id>` 找回），这个阶段从头跑。
- [ ] 在 e2e 阶段杀掉 worker：环境被回收，e2e 重跑，结果一致。
- [ ] 在 diagnose 中杀掉 worker：同上，修复票不会建两张。
- [ ] 在 `pr-ready` 时杀掉 worker：重跑后 PR 是 ready，状态一致。
- [ ] 故意写坏一个 compose 片段：三次失败后进 `integration-environment-failed`，没有残留的网络和容器。

### 已知的、没有实测过的

- `pr-ready` 用 Pull requests 写权限把 draft 转 ready（GraphQL `markPullRequestReadyForReview`）。
- 两个以上的 compose 片段合并（原型只验证了一个后端）。
- 修复票的循环在真实运行里的表现（原型只验证了诊断能判对出错的仓库）。
