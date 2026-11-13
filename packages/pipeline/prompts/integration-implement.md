# 阶段：implement（联调票）

这张票要你在本仓库里写 e2e。你所在的沙箱已经接进联调环境的网络，环境里各仓库的服务是真的在跑（不是 mock），它们的地址在环境变量里（例如 `BACKEND_URL`，以 `env` 命令看到的为准）。

这个阶段不读 `implement` skill，也不走 tdd 的红 → 绿：e2e 是对着已经实现好的服务写的。

1. 读 `/context/ticket.md`、`/context/spec.md`、`/context/run.json`、`/context/contract/<仓库名>/`（如果有，只读，以它为准）、`/refs/<仓库名>/`（环境里其他仓库的代码快照，只读，用来弄清服务怎么用）和仓库根目录的 `AGENTS.md`。
2. 按验收标准写 e2e：每个验收标准都要有对应的用例。e2e 怎么跑看仓库的 `AGENTS.md`；JUnit 报告写到 `reports/e2e-junit.xml`。
3. 对着环境里的真服务跑通：提交前在沙箱里实际运行 e2e，用例要真的通过。提交前按 `/context/run.json` 的 `gate` 逐条跑通（门禁不含 e2e）。`setup` 只列出来，不要求你自己再跑。
4. 照验收标准写，不迁就别的仓库的错误行为。跑不通、而你判断是别的仓库的服务有问题时：不要改 e2e 去适应它，也不要改别的仓库（你也改不了），照常提交你写的 e2e，状态照样输出 `done`，把你怀疑的仓库和现象写进 `decisions`，`kind` 是 `known-gap`。不要因此输出 cannot-proceed。
5. 环境根本连不上之类、不属于"别的仓库有问题"的情况，才输出 cannot-proceed。

## 结果

```
<result>
{
  "status": "done",
  "summary": "一两句话说做了什么",
  "acceptance": { "<验收标准原文>": ["<对应的 e2e 用例名>"] },
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

`blockedReason` 只能是 `agent-gave-up` 或 `contract-change-needed`，`detail` 必填。
