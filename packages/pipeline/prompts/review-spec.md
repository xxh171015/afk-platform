# 阶段：review，Spec 轴

只审查，不修改任何文件，不提交。

这是对一张票的审查，用 `code-review` skill：读 `/home/agent/.cursor/skills/code-review/SKILL.md`。它的第 1–3 步已经替你做完了，答案如下：

- 固定点：`/context/run.json` 的 `baseSha`。diff 用 `git diff <baseSha>...HEAD`，commit 列表用 `git log <baseSha>..HEAD --oneline`。
- spec 来源：**`/context/ticket.md`**（这张票的 `## What to build` 和 `## Acceptance criteria`）和 `/context/contract/<仓库名>/`（如果有，改动必须符合它）。`/context/spec.md` 只是背景，不是审查的对照物。若其中有「这张票负责的 User Story」一节的原文，那几条也是对照物。这张票的 What to build、它负责的 User Story 原文，与验收标准是同等的对照物。只写在 What to build 或 User Story 里的要求漏做或做了一半，按 (a) 进 `mustFix`；「验收标准没写」不能作为降级的理由。拿不准时判 `mustFix`，同时写进 `uncertainties`。
- 决策日志：`/context/decisions.json` 这张票之前各阶段的决定。对其中每条 `conflict` 和 `known-gap` 给一条 Ruling `{ id, verdict }`：`accepted`（票允许这样做）、`must-fix`（同时进 `mustFix`，`id` 与决定相同，且 `verdict` 必须是 `fix`）、或 `needs-human`（不挡流程，开 PR 时列给人定）。`choice` 和 `workaround` 不要求。有这两类决定却缺 Ruling 就是无效结果。

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
  "verdict": "fix",
  "mustFix": [{ "file": "src/x.ts", "line": 12, "problem": "缺了……；票里这一句：「……」" }],
  "suggestions": [],
  "scopeCreep": ["没被要求的行为..."],
  "uncertainties": ["..."],
  "rulings": [{ "id": "R-123#0", "verdict": "accepted" }]
}
</result>
```

`verdict` 只能是 `"pass"` 或 `"fix"`；`mustFix` 非空时必须是 `"fix"`，没有就是空数组和 `"pass"`。`mustFix` 的每一条都是对象 `{ "file", "line", "problem" }`（`line` 可省略），不能写成一句字符串，否则整条结果无效。
