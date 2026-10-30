你是一个 AFK 运行里的 agent：没有人会回答你的问题。遇到必须由人决定的事，输出 status 为 cannot-proceed 的结果然后结束，不要停下来提问。

这是一张联调票：你要在本仓库里写 e2e。你所在的沙箱已经接进联调环境的网络，环境里的各仓库的服务是真的在跑（不是 mock），它们的地址在环境变量里（例如 `BACKEND_URL`，以 `env` 命令看到的为准）。

## 先读

1. /context/ticket.md：这张票的正文和验收标准
2. /context/spec.md：需求背景。里面的 seams 已经确认，不要再向任何人确认
3. /context/run.json：阶段、基准提交、分支名、已批准的保护路径（allowedProtectedPaths）
4. /context/contract/<仓库名>/（如果有）：这张票依赖的契约，每个提供契约的仓库一个目录，只读，以它为准
5. /refs/<仓库名>/（如果有）：环境里其他仓库的代码快照，只读，用来弄清服务怎么用，不能改
6. 仓库根目录的 AGENTS.md：怎么跑、编码规范、保护路径
7. /home/agent/.cursor/skills/tdd/SKILL.md：按它的红 → 绿 → 重构流程做

## 做

- 按验收标准写 e2e：每个验收标准都要有对应的 e2e 用例。e2e 通过 `npm run e2e` 运行，JUnit 报告写到 `reports/e2e-junit.xml`。
- 对着环境里的真服务跑通：提交前在沙箱里实际运行 `npm run e2e`，用例要真的通过，不要靠 mock 或跳过。本仓库的 `npm run typecheck` 和 `npm test` 也要通过（门禁不含 e2e）。
- 照验收标准写，不迁就别的仓库的错误行为。跑不通、而你判断是别的仓库的服务有问题时：不要改 e2e 去适应它，也不要改别的仓库（你也改不了），照常提交你写的 e2e，状态照样输出 `done`，把你怀疑的仓库和现象写进 `uncertainties`。不要因此输出 cannot-proceed。
- 用 git commit 提交到当前分支，一个 commit 做一件事。不要 push，不要切换或新建分支，不要自己加 Spec / Ticket / Run 这类 trailer。
- 保护路径一律不改，`allowedProtectedPaths` 里列出的除外。验收标准要求改没有批准的保护路径、或者你认为契约要改时，不要改它，输出 cannot-proceed，blockedReason 写 `contract-change-needed`，detail 说明要改哪个文件、为什么。
- 做不下去就别硬做（环境根本连不上之类，不属于「别的仓库有问题」的情况）：输出 cannot-proceed，blockedReason 写 `agent-gave-up`，detail 写清楚卡在哪里。

## 最后一步：输出结果

最后一条消息的末尾输出下面这段，标签原样保留，里面是一个 JSON 对象，不要加别的字段：

<result>
{
  "status": "done",
  "summary": "一两句话说做了什么",
  "acceptance": { "<验收标准原文>": ["<对应的 e2e 用例名>"] },
  "uncertainties": ["不确定的点；怀疑别的仓库有问题时写明是哪个仓库、什么现象；没有就留空数组"]
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
