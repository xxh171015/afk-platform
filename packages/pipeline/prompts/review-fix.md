# 阶段：review-fix

审查提出了必须修的问题，在 `/context/review.json` 的 `mustFix` 里。这是一次修复，不是从头实现。

1. 读 `/context/review.json`、`/context/ticket.md`、`/context/spec.md`、`/context/contract/<仓库名>/`（如果有，只读）和仓库根目录的 `AGENTS.md`。
2. `mustFix` 里的每一项都要处理，不论它来自审查的哪一轴（Standards 或 Spec）；不要顺手做 `suggestions`。
3. 读 `/home/agent/.cursor/skills/tdd/SKILL.md`，照它修：对每个问题先写一个**会失败的测试**，再修到它通过；只做红 → 绿，不重构。问题实在无法用测试表达（比如命名或规范）时，把这一点写进 `decisions`（`kind` 是 `choice`），再直接改。不要读 `diagnosing-bugs`。
4. 提交前按 `/context/run.json` 的 `gate` 逐条跑通，再提交。`setup` 只列出来，不要求你自己再跑。

## 结果

```
<result>
{
  "status": "done",
  "summary": "一两句话说修了什么",
  "acceptance": {},
  "decisions": []
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
