# AFK 研发平台

让实现阶段无人值守的研发平台：人只在规划和最终合并时出现，中间由平台按依赖图调度 agent 在沙箱里逐张票实现。

## 规划

**Project（项目）**：
一个产品，包含一个或多个仓库。
_Avoid_: 产品线、应用

**Repo（仓库）**：
项目下的一个有名字的代码仓库，不分前端后端；名字在项目内唯一，导入文件里用它称呼仓库。每个仓库登记一个托管类型（Host kind：github 或 gitlab），Tracker doc 按它选代码托管部分。一个 Spec 可以改项目里任意几个仓库；票只往自己的仓库提交，可以只读参考项目里的任何仓库。
_Avoid_: 代码库、工程、主仓库、角色

**Spec（需求）**：
一个要交付的需求（feature / bug / improvement），是拆票的来源。可以整个取消（`plat spec cancel`）：没做完的票和作业一并停掉，已合并的票留着；随后由带代码托管凭据的 worker 关掉它还开着的 PR、删掉它的 `spec/*` 和 `agent/*` 分支（spec merged 之后也删分支）。有 PR 已被合并、又还有开着的 PR 时不能取消（部分合并、其余 PR 都已关闭的可以取消，已合并的部分留在 main 上）。所有票都被取消、没有一张 done 时自动取消。
_Avoid_: 父票、epic、story

**Ticket（票）**：
平台里的一张实现票，属于一个 Spec，只改一个 Repo。只指平台里的这个实体；规划过程中 GitHub Issues 上的决策票不叫 Ticket。正文和 to-tickets 的 issue 模板原文一字不差，验收标准就是正文里 Acceptance criteria 一节的各条，不另写一份。
_Avoid_: 任务、issue、子票

**Content version（内容版本）**：
Ticket 内容（标题、正文（含验收标准）、模块、已批准的保护路径）的版本号，每次改票加一；每个版本都留存，Run 记下它看到的是哪一版。仓库、类型和依赖边不属于内容，不能改。
_Avoid_: 修订号、票版本

**Integration ticket（联调票）**：
在使用方仓库（比如前端）里、对着真实运行的其他仓库验证端到端行为的 Ticket。它的 agent 在联调环境里写 e2e 测试、对着真服务跑通，合并之后由平台在新起的联调环境里再跑；跑不通就由平台诊断出错的仓库并建修复票，修好后再跑，最多两轮。
_Avoid_: e2e 票、集成测试票

**Fix ticket（修复票）**：
联调失败后由平台自动建在出错仓库里的 Ticket，挡在联调票前面；它修好合并后，联调票重新跑 e2e。人不写修复票，人要补的改动用追加。
_Avoid_: bug 票、返工票

**Diagnosis（诊断）**：
联调票的 e2e 失败后，agent 在一个新起的联调环境里只看不改，查出哪个仓库有问题（`failingRepo`，查不出来是 `unknown`），并给出证据和失败用例。平台据此建修复票。

**Integration round（联调轮）**：
一次失败的 e2e 加随后建出的修复票算一轮，最多两轮；第三次 e2e 失败就进 blocked。人「重新跑 e2e」时轮数清零。每次 e2e（不论成败）叫一次联调运行（attempt）。

**Final e2e（开 PR 前的联调）**：
各仓库收尾完成后、开 PR 之前，如果有仓库跑过 final-fix，spec 里每张联调票再跑一次 e2e（失败的再诊断一次，只为给简报证据）。全过才开 PR；有失败收尾就 blocked，人可以再跑一次，或放行（验收包「联调」一节最前面写明开 PR 前的联调失败）。

**Integration environment（联调环境）**：
一次联调临时起的一组服务：联调票声明的各仓库，各自从本 Spec 的集成分支（没有就用 main）构建，放在同一个网络里；联调票所在仓库的沙箱加入这个网络：agent 写 e2e（implement 和各种 fix）时、agent 诊断失败的 e2e 时，以及平台跑 e2e 时。每次运行都新起一个，用完即拆。
_Avoid_: 测试环境、staging

**Edge（依赖边）**：
两张 Ticket 之间的依赖，类型是 blocks 或 contract。一张票有多条 contract 入边时，用依赖图里最下游的那张契约票的 Contract SHA。
_Avoid_: 依赖关系、blocked_by

**Append（追加）**：
往一个已确认、还没进入收尾的 Spec 里再导入一批 Ticket 和 Edge，立即生效、不再确认拆分。每条新边至少连着一张新票；已经开工或做完的票不能再被新票挡住。改契约、拆票都靠追加，做完的票不重开，要改就追加适配票。
_Avoid_: 补票、重开

**Serial ID（序号）**：
库里的自增主键，Spec、Ticket、Run 等实体各有一个，只在库内部用。
_Avoid_: 编号（容易和显示编号混）

**Display ID（显示编号）**：
给人看和写进 commit trailer 的编号：前缀加序号，Spec 是 `S-12`，Ticket 是 `T-123`，Run 是 `R-456`。不存库，由 Serial ID 现算。
_Avoid_: 票号、工单号

**Contract（契约）**：
一个仓库对外提供的接口描述，写在这个仓库里；哪个仓库都可以有，也可以没有。用它的仓库通过 contract 边依赖它。
_Avoid_: 接口文档、API 定义

**Contract SHA（契约 SHA）**：
契约票合并后集成分支的 head；下游票只使用这个提交上的契约。

**Contract copy（契约副本）**：
使用方仓库里提交的一份别的仓库的契约，生成的 client 以它为准。它必须和这个仓库的票所用的 Contract SHA 上的契约一字不差；没有 contract 入边的票不许改它。
_Avoid_: 契约快照、本地契约

**Tracker doc（tracker 文档）**：
规划仓库里告诉 matt skills 去哪里、怎么发布内容的文档：Spec 和 Ticket 发布到平台，其余（地图、分诊）留在代码托管上。由平台按项目和仓库生成（第一行写平台版本、skills SHA、项目和仓库），不手改。
_Avoid_: tracker 配置、issue-tracker 模板

**Skills SHA（skills SHA）**：
平台固定使用的 [mattpocock/skills](https://github.com/mattpocock/skills) commit；worker 只挂这个提交上的 `skills/engineering`，Run 记下这个 SHA。常量 `SKILLS_SHA`（`packages/shared/src/skills-sha.ts`）是它唯一的写法，别处只引用；平台依赖的 skill 文件按这个 SHA 存成快照（`packages/shared/skills-snapshot/`）。

## 执行

**Run（运行）**：
一次 agent 运行或一次确定性步骤的尝试记录，每次尝试新增一条，不覆盖。
_Avoid_: 执行、任务

**Overlay（覆盖层）**：
平台叠在 matt skill 之上的规则，让 skill 原样在无人值守的 Run 里跑：替 skill 回答它本来要问人的问题，并加上平台的约束。和它对应的 Skills SHA 绑定。
_Avoid_: 补丁、包装 prompt、fork

**Integration branch（集成分支）**：
一个 Spec 在一个 Repo 里的分支 `spec/<id>/<slug>`（`<id>` 是数据库的标识，六位十六进制；标识出现之前建的 spec 是 `spec/<slug>`），票合并到这里，最后以 PR 的形式合进 main。票的分支是 `agent/<id>/T-<n>`，总览修复的是 `agent/<id>/S-<n>-final`。
_Avoid_: 特性分支、feature branch

**Lock key（互斥键）**：
作业上的一个可空标签；带相同键的作业领取时互斥，持有期等于租约期。集成分支锁就是以“仓库:集成分支”为键的互斥键。
_Avoid_: 分布式锁、advisory lock

**Slot（槽位）**：
Worker 上一次任务独占的一次性 clone，沙箱只挂它，不挂主 clone；任务结束即删（失败的保留到下次占用）。
_Avoid_: 工作区、沙箱目录

**Gate（门禁）**：
在不信任 agent 的前提下判断一次改动能否接受的确定性检查。
_Avoid_: CI、检查

**Protected path（保护路径）**：
agent 不允许改动的路径，改了就需要人批准。

**Approved protected path（已批准的保护路径）**：
人在确认拆分时为某张 Ticket 提前批准可以改动的保护路径；Ticket 被阻塞后，也可以在重试前追加；只对这张 Ticket 有效，其余保护路径仍然不许改。
_Avoid_: 白名单、豁免路径

**Blocked reason（blocked 原因码）**：
票进入 blocked 时附带的原因代码，决定人可以采取的处理动作。

**Finding（意见）**：
review 意见或门禁失败，以及它的处理结果。
_Avoid_: 评论、issue

**Review axis（审查轴）**：
审查的两个互相独立的角度：Standards（是否符合仓库写明的规范）和 Spec（是否做了票或需求要求的事）。每条 review 意见属于一轴，两轴分开记，不跨轴排名。
_Avoid_: 维度、审查类型

**Link（追溯链接）**：
commit 与 Ticket、Spec、PR、缺陷之间的对应关系。

**Acceptance pack（验收包）**：
Spec 收尾时给人看的简报，人据此决定是否合并。
_Avoid_: 报告、总结

**Merge order（合并顺序）**：
一个 Spec 的各仓库 PR 应当按什么先后合进 main：由这个 Spec 里的 contract 边推出，提供契约的仓库先合，使用它的仓库的 PR 在那之前保持 draft；没有契约关系的仓库之间没有顺序。人违反顺序时（先合了还在等别的 PR 的那个）只记录，不阻止：Spec 上标「合并顺序被打破」，状态照常推进，不进 `plat blocked`。
_Avoid_: 发布顺序、上线顺序
