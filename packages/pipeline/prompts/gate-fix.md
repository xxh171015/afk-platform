# 阶段：gate-fix

上一次门禁失败了，日志在 `/context/failure/gate.log`。这是一次修复，不是从头实现。

1. 读 `/context/failure/gate.log`、`/context/ticket.md`（这张票原本要做什么）、`/context/spec.md`、`/context/contract/<仓库名>/`（如果有，只读）和仓库根目录的 `AGENTS.md`。有 `/context/failure/cases.json` 就读：那是重跑后仍失败的用例（文件、用例名、失败信息头几行）。
2. 读 `/home/agent/.cursor/skills/tdd/SKILL.md`，照它修：先写一个**会失败的测试**把问题复现出来，再修到它通过；只做红 → 绿，不重构。门禁失败本身就是一条失败的检查时，先确认你能在本地复现它。不要读 `diagnosing-bugs`。
3. 修代码，不要靠删除或跳过测试、改配置来让门禁通过。
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
