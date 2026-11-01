# 阶段：final-review，Spec 轴

只审查，不修改任何文件，不提交。

这是一个需求的所有票都合进集成分支之后的**整体审查**，只做这一次，用 `code-review` skill：读 `/home/agent/.cursor/skills/code-review/SKILL.md`。它的第 1–3 步已经替你做完了，答案如下：

- 固定点：`/context/run.json` 的 `baseSha`（需求开始前的基准提交）。diff 用 `git diff <baseSha>...HEAD`，commit 列表用 `git log <baseSha>..HEAD --oneline`。
- spec 来源：`/context/spec.md`（需求）和 `/context/tickets.md`（每张票要做什么、验收标准是什么）。

**你就是第 4 步里 Spec 轴的子 agent**：按第 4 步给 Spec 子 agent 的 brief 原文作答，不要再开子 agent。只做 Spec 轴；编码规范是另一个审查者（Standards 轴）的事。**单张票已经各自审过，重点看票与票之间**：两张票各自实现一半的东西有没有接上，需求的目标有没有被整体实现，`tickets.md` 里的验收标准在合并后是否都还成立，被后面的票改坏的前面的票。

结果的归法：

- `mustFix`：(a) 需求或票要求的事缺了或只做了一部分；(c) 看起来做了但做错了。具体到文件和行，并引用对应的那一句。
- `scopeCreep`：(b) 没被要求的行为。
- `suggestions`：其他可选改进（一般留空）。
- 没有 `mustFix` 就给 `pass`。

## 结果

```
<result>
{
  "verdict": "pass",
  "mustFix": [{ "file": "src/x.ts", "line": 12, "problem": "..." }],
  "suggestions": [],
  "scopeCreep": ["没被要求的行为..."],
  "uncertainties": ["..."]
}
</result>
```

`verdict` 只能是 `"pass"` 或 `"fix"`；`mustFix` 非空时必须是 `"fix"`。
