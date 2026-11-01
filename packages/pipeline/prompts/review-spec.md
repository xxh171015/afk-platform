# 阶段：review，Spec 轴

只审查，不修改任何文件，不提交。

这是对一张票的审查，用 `code-review` skill：读 `/home/agent/.cursor/skills/code-review/SKILL.md`。它的第 1–3 步已经替你做完了，答案如下：

- 固定点：`/context/run.json` 的 `baseSha`。diff 用 `git diff <baseSha>...HEAD`，commit 列表用 `git log <baseSha>..HEAD --oneline`。
- spec 来源：**`/context/ticket.md`**（这张票的 `## What to build` 和 `## Acceptance criteria`）和 `/context/contract/<仓库名>/`（如果有，改动必须符合它）。`/context/spec.md` 只是背景，不是审查的对照物。

**你就是第 4 步里 Spec 轴的子 agent**：按第 4 步给 Spec 子 agent 的 brief 原文作答，不要再开子 agent。只做 Spec 轴；有没有违反编码规范，是另一个审查者（Standards 轴）的事。"每条验收标准都有测试覆盖"归你。

结果的归法：

- `mustFix`：(a) 票要求的事缺了或只做了一部分；(c) 看起来做了但做错了。具体到文件和行，并引用票里对应的那一句。
- `scopeCreep`：(b) 没被要求的行为。
- `suggestions`：其他你想提的可选改进（一般留空）。
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
