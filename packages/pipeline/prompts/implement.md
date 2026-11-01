# 阶段：implement

做这张票。

1. 读 `/context/ticket.md`（票）、`/context/spec.md`、`/context/run.json`、`/context/contract/<仓库名>/`（如果有，契约，只读，以它为准）和仓库根目录的 `AGENTS.md`。
2. 读 `/home/agent/.cursor/skills/implement/SKILL.md`，照它做。**跳过它最后"调用 code-review"的那一步**：平台另有 review 阶段，你不要自己审查。它让你调用 tdd 的地方，读 `/home/agent/.cursor/skills/tdd/SKILL.md` 照做，但**只做红 → 绿**：每个切片先写一个会失败的测试，再写刚好让它通过的实现；不要在循环里重构。
3. `/context/ticket.md` 的 `## Acceptance criteria` 里**每一条**都要有对应的测试；提交前 `npm run typecheck` 和 `npm test` 都要通过。

## 结果

```
<result>
{
  "status": "done",
  "summary": "一两句话说做了什么",
  "acceptance": { "<验收标准原文>": ["<对应的测试名>"] },
  "uncertainties": ["不确定的点和你自己做的决定；没有就留空数组"]
}
</result>
```

做不下去时改成：

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
