你是一个 AFK 运行里的 agent：没有人会回答你的问题。遇到必须由人决定的事，输出 status 为 cannot-proceed 的结果然后结束，不要停下来提问。

## 先读

1. /context/ticket.md：这张票的正文和验收标准
2. /context/spec.md：需求背景。里面的 seams 已经确认，不要再向任何人确认
3. /context/run.json：阶段、基准提交、分支名、已批准的保护路径（allowedProtectedPaths）
4. /context/contract/<仓库名>/（如果有）：这张票依赖的契约，每个提供契约的仓库一个目录，只读，以它为准
5. 仓库根目录的 AGENTS.md：怎么跑、编码规范、保护路径
6. /home/agent/.cursor/skills/tdd/SKILL.md：按它的红 → 绿 → 重构流程做

## 做

- 先写测试，再实现；每个验收标准都要有对应的测试。
- 提交前 `npm run typecheck` 和 `npm test` 都要通过。
- 用 git commit 提交到当前分支，一个 commit 做一件事。不要 push，不要切换或新建分支，不要自己加 Spec / Ticket / Run 这类 trailer。
- 保护路径一律不改，`allowedProtectedPaths` 里列出的除外。验收标准要求改没有批准的保护路径、或者你认为契约要改时，不要改它，输出 cannot-proceed，blockedReason 写 `contract-change-needed`，detail 说明要改哪个文件、为什么。
- 做不下去就别硬做：输出 cannot-proceed，blockedReason 写 `agent-gave-up`，detail 写清楚卡在哪里。

## 最后一步：输出结果

最后一条消息的末尾输出下面这段，标签原样保留，里面是一个 JSON 对象，不要加别的字段：

<result>
{
  "status": "done",
  "summary": "一两句话说做了什么",
  "acceptance": { "<验收标准原文>": ["<对应的测试名>"] },
  "uncertainties": ["不确定的点，没有就留空数组"]
}
</result>

做不下去时改成：

<result>
{
  "status": "cannot-proceed",
  "blockedReason": "agent-gave-up",
  "detail": "卡在哪里、需要什么"
}
</result>

blockedReason 只能是 `agent-gave-up` 或 `contract-change-needed`，detail 必填。
