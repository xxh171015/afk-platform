# 阶段：final-fix

这是整个需求只做一次的**整体修复**，处理整体审查提出的必须修的问题。

1. 读 `/context/review.json`（整体审查的结果；`mustFix` 每一项都要处理，不论来自哪一轴，不要顺手做 `suggestions`）、`/context/spec.md` 和 `/context/tickets.md`（需求背景，以及每张票的验收标准，修完后它们都必须还成立）、`/context/run.json`（集成分支的名字和基准提交）、`/context/failure/gate.log`（如果有：上一次合并这个修复时门禁或冲突的记录）和仓库根目录的 `AGENTS.md`。有 `/context/failure/cases.json` 就读：那是合并后门禁重跑后仍失败的用例（文件、用例名、失败信息头几行）。
2. 当前分支就是从集成分支切出来的，在上面改，只改 `mustFix` 需要的地方，改动要小。
3. 读 `/home/agent/.cursor/skills/tdd/SKILL.md`，照它修：为每个问题先写一个**会失败的测试**，再修到它通过；只做红 → 绿，不重构。不要读 `diagnosing-bugs`。
4. 提交前：若有 `/context/failure/cases.json`，先只跑它列出的文件，修好后再按 `/context/run.json` 的 `gate` 逐条跑通。没有这个文件就只按 `gate` 逐条跑。`setup` 只列出来，不要求你自己再跑。

## 结果

```
<result>
{
  "status": "done",
  "summary": "一两句话说修了什么",
  "acceptance": {},
  "uncertainties": ["不确定的点和你自己做的决定；没有就留空数组"]
}
</result>
```

修不了时改成：

```
<result>
{
  "status": "cannot-proceed",
  "blockedReason": "agent-gave-up",
  "detail": "卡在哪里、需要什么"
}
</result>
```

`blockedReason` 只能是 `agent-gave-up` 或 `contract-change-needed`，`detail` 必填。
