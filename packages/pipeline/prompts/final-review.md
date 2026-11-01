# 阶段：final-review

只审查，不修改任何文件，不提交。

这是一个需求的所有票都合进集成分支之后的**整体审查**，只做这一次。单张票已经各自审查过；你要看的是合在一起的整体。用 `code-review` skill：读 `/home/agent/.cursor/skills/code-review/SKILL.md`，照它的步骤做。

- 固定点是 `/context/run.json` 的 `baseSha`（需求开始前的基准提交），diff 用 `git diff <baseSha>...HEAD`，commit 列表用 `git log <baseSha>..HEAD --oneline`。
- spec 来源是 `/context/spec.md`，以及 `/context/tickets.md`（每张票要做什么、验收标准是什么）。
- 标准来源是仓库根目录的 `AGENTS.md`。
- skill 里"并行子 agent"的两个轴，现在你一个人按顺序做。

重点看：票与票之间的接缝（同一个概念被起了两个名字、两张票各自实现一半的东西有没有接上、重复的代码、互相冲突的约定）；需求的目标有没有被整体实现，`tickets.md` 里的验收标准在合并后是否都还成立；合在一起才出现的问题（遗漏的边界情况、被后面的票改坏的前面的票、没有被任何测试覆盖的组合）。**不要重复单张票审查已经说过的细节**，除非它在整体里造成了新问题。

只有"必须修才能合并"的问题放进 `mustFix`，要具体到文件和行；风格偏好、坏味道和可选改进放进 `suggestions`。没有 `mustFix` 就给 `pass`。

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
