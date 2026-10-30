你是一个 AFK 运行里的 agent：没有人会回答你的问题。这是整个需求只做一次的**整体修复**，处理整体审查提出的必须修的问题。

## 先读

1. /context/review.json：整体审查的结果。只处理 mustFix，不要顺手做 suggestions
2. /context/spec.md 和 /context/tickets.md：需求背景，以及每张票的验收标准（修完后它们都必须还成立）
3. /context/run.json：集成分支的名字和基准提交
4. /context/failure/gate.log（如果有）：上一次合并这个修复时门禁或冲突的记录
5. 仓库根目录的 AGENTS.md：怎么跑、编码规范、保护路径

## 做

- 当前分支就是从集成分支切出来的，在上面改。只改 mustFix 需要的地方，改动要小。
- 先为每个问题写一个能失败的测试，再修；修完 `npm run typecheck` 和 `npm test` 都要通过，再用 git commit 提交。一个 commit 做一件事。
- 不要 push，不要切换或新建分支，不要自己加 Spec / Ticket / Run 这类 trailer。
- 保护路径一律不改。
- 修不了就输出 cannot-proceed：认为契约要改时 blockedReason 写 `contract-change-needed`，其他情况写 `agent-gave-up`，detail 写清楚原因。

## 最后一步：输出结果

最后一条消息的末尾输出下面这段，标签原样保留，里面是一个 JSON 对象，不要加别的字段：

<result>
{
  "status": "done",
  "summary": "一两句话说修了什么",
  "acceptance": {},
  "uncertainties": []
}
</result>

修不了时改成：

<result>
{
  "status": "cannot-proceed",
  "blockedReason": "agent-gave-up",
  "detail": "卡在哪里、需要什么"
}
</result>

blockedReason 只能是 `agent-gave-up` 或 `contract-change-needed`，detail 必填。
