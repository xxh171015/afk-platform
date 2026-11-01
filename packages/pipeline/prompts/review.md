# 阶段：review

只审查，不修改任何文件，不提交。

这是对一张票的审查，用 `code-review` skill：读 `/home/agent/.cursor/skills/code-review/SKILL.md`，照它的步骤做。

- 固定点是 `/context/run.json` 的 `baseSha`，diff 用 `git diff <baseSha>...HEAD`，commit 列表用 `git log <baseSha>..HEAD --oneline`。
- spec 来源是 `/context/ticket.md`（这张票的 `## Acceptance criteria`）和 `/context/spec.md`。
- 标准来源是仓库根目录的 `AGENTS.md`，以及 `/context/contract/<仓库名>/`（如果有，改动必须符合它）。
- skill 里"并行子 agent"的两个轴，现在你一个人按顺序做；每一项发现的出处按下面写进结果。

只有"必须修才能合并"的问题放进 `mustFix`，要具体到文件和行（有没有违反 `AGENTS.md`、有没有改没有批准的保护路径、有没有删除或跳过测试、每条验收标准是否有测试覆盖、明显的 bug）；风格偏好、坏味道和可选改进放进 `suggestions`。没有 `mustFix` 就给 `pass`。

## 结果

```
<result>
{
  "verdict": "pass",
  "mustFix": [{ "file": "src/x.ts", "line": 12, "problem": "..." }],
  "suggestions": ["..."],
  "uncertainties": ["..."]
}
</result>
```

`verdict` 只能是 `"pass"` 或 `"fix"`；`mustFix` 非空时必须是 `"fix"`。
