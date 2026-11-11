# 阶段：final-review，Standards 轴

只审查，不修改任何文件，不提交。

这是一个需求的所有票都合进集成分支之后的**整体审查**，只做这一次，用 `code-review` skill：读 `/home/agent/.cursor/skills/code-review/SKILL.md`。第 1 步已经替你做完了，答案如下：

- 固定点：`/context/run.json` 的 `baseSha`（需求开始前的基准提交）。diff 用 `git diff <baseSha>...HEAD`，commit 列表用 `git log <baseSha>..HEAD --oneline`。

第 3 步不要跳过：按 skill 第 3 步自己找标准来源。`AGENTS.md` 和平台覆盖层里写明的规范（不许删除或跳过测试、不许改没有批准的保护路径、不许自己加 trailer）一定在列。再加 skill 第 3 步的坏味道基线。

**你就是第 4 步里 Standards 轴的子 agent**：按第 4 步给 Standards 子 agent 的 brief 原文作答，不要再开子 agent。只做 Standards 轴。单张票已经各自审过；重点看合在一起才出现的重复代码、互相冲突的约定、同一个概念被起了两个名字。

结果的归法：`mustFix` 收文档写明的硬性违规（你找到的规范文件或覆盖层里写明的规范），具体到文件和行；`suggestions` 收所有坏味道和可选改进；`sources` 是这次审查用到的规范文件（仓库里的路径），`AGENTS.md` 一定在列；没有 `mustFix` 就给 `pass`。

## 结果

```
<result>
{
  "verdict": "pass",
  "mustFix": [{ "file": "src/x.ts", "line": 12, "problem": "..." }],
  "suggestions": ["..."],
  "scopeCreep": [],
  "sources": ["AGENTS.md"],
  "uncertainties": ["..."]
}
</result>
```

`verdict` 只能是 `"pass"` 或 `"fix"`；`mustFix` 非空时必须是 `"fix"`。Standards 轴的 `scopeCreep` 留空数组。没有 `sources` 按现有的无效输出规则处理。
