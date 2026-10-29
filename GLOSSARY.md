# AFK 研发平台

让实现阶段无人值守的研发平台：人只在规划和最终合并时出现，中间由平台按依赖图调度 agent 在沙箱里逐张票实现。

## 规划

**Project（项目）**：
一个产品，包含一个或多个仓库。
_Avoid_: 产品线、应用

**Repo（仓库）**：
项目下的一个代码仓库，角色是主仓库（后端，存放契约）或前端仓库。
_Avoid_: 代码库、工程

**Spec（需求）**：
一个要交付的需求（feature / bug / improvement），是拆票的来源。可以整个取消（`plat spec cancel`）：没做完的票和作业一并停掉，已合并的票留着；随后由带代码托管凭据的 worker 关掉它还开着的 PR、删掉它的 `spec/*` 和 `agent/*` 分支（spec merged 之后也删分支）。有 PR 已被合并的 spec 不能取消。所有票都被取消、没有一张 done 时自动取消。
_Avoid_: 父票、epic、story

**Ticket（票）**：
平台里的一张实现票，属于一个 Spec，只改一个 Repo。只指平台里的这个实体；规划过程中 GitHub Issues 上的决策票不叫 Ticket。
_Avoid_: 任务、issue、子票

**Edge（依赖边）**：
两张 Ticket 之间的依赖，类型是 blocks 或 contract。
_Avoid_: 依赖关系、blocked_by

**Serial ID（序号）**：
库里的自增主键，Spec、Ticket、Run 等实体各有一个，只在库内部用。
_Avoid_: 编号（容易和显示编号混）

**Display ID（显示编号）**：
给人看和写进 commit trailer 的编号：前缀加序号，Spec 是 `S-12`，Ticket 是 `T-123`，Run 是 `R-456`。不存库，由 Serial ID 现算。
_Avoid_: 票号、工单号

**Contract（契约）**：
写在主仓库里的前后端接口描述。
_Avoid_: 接口文档、API 定义

**Contract SHA（契约 SHA）**：
契约票合并后集成分支的 head；下游票只使用这个提交上的契约。

**Skills SHA（skills SHA）**：
平台固定使用的 [mattpocock/skills](https://github.com/mattpocock/skills) commit；worker 只挂这个提交上的 `skills/engineering`，Run 记下这个 SHA。当前固定为 `59db609eb1e18aaf59b63284d0e52255aff0c63c`。

## 执行

**Run（运行）**：
一次 agent 运行或一次确定性步骤的尝试记录，每次尝试新增一条，不覆盖。
_Avoid_: 执行、任务

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

**Link（追溯链接）**：
commit 与 Ticket、Spec、PR、缺陷之间的对应关系。

**Acceptance pack（验收包）**：
Spec 收尾时给人看的简报，人据此决定是否合并。
_Avoid_: 报告、总结
