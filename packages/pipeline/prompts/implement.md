# 阶段：implement

做这张票。

1. 读 `/context/ticket.md`（票）、`/context/spec.md`、`/context/tickets.md`（同一需求的其他票：modules、状态，本票有标记）、`/context/run.json`、`/context/contract/<仓库名>/`（如果有，契约，只读，以它为准）、`/context/domain/`（如果有，规划仓库的 GLOSSARY 和 ADR，只读）和仓库根目录的 `AGENTS.md`。
2. 读 `/home/agent/.cursor/skills/implement/SKILL.md`，照它做。**跳过它最后"调用 code-review"的那一步**：平台另有 review 阶段，你不要自己审查。它让你调用 tdd 的地方，读 `/home/agent/.cursor/skills/tdd/SKILL.md` 照做，但**只做红 → 绿**：每个切片先写一个会失败的测试，再写刚好让它通过的实现；不要在循环里重构。
3. `/context/ticket.md` 的 What to build 的每一句都要做到，不只是验收标准；做不到的记 `known-gap`。`/context/spec.md` 里写给整个需求的规则（权限、范围、只读、数据一致性这类约束，常见于 Implementation Decisions、Testing Decisions 等节），凡是这张票改到的代码都要遵守；做不到记 `known-gap`。要求的实现落在另一张还没 done 的票的 modules 里时，不要自己做，记一条 `deferred`，`ref` 为那张票，`text` 说明是哪条要求。`## Acceptance criteria` 里**每一条**都要有对应的测试；提交前按 `/context/run.json` 的 `gate` 逐条跑通。`setup` 只列出来，不要求你自己再跑。

## 结果

```
<result>
{
  "status": "done",
  "summary": "一两句话说做了什么",
  "acceptance": { "<验收标准原文>": ["<对应的测试名>"] },
  "decisions": []
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

`summary` 是一句字符串。`acceptance` 的值是测试名字符串的数组。`decisions` 是对象数组，每项 `{ "kind", "text" }`，只有 `kind` 是 `deferred` 时才带 `ref`（T-n 或 `new`）。`blockedReason` 只能是 `agent-gave-up` 或 `contract-change-needed`，`detail` 是一句字符串。
