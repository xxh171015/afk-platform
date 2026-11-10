# 阶段：update-branch

默认分支在这个需求之外前进了，合进集成分支时冲突了，或者合并候选的门禁失败了（日志在 `/context/failure/gate.log`，如果有）。这个阶段不读 skill，只用覆盖层。

不要改集成分支。你的提交只在 `run.json` 的 `branch` 上；平台随后把它合进去。

1. 读 `/context/run.json`：`integrationBranch` 是集成分支，`defaultBranch` 是要合进来的默认分支，`branch` 是你工作的临时分支。再读 `/context/spec.md` 弄清这个需求的意图，以及仓库根目录的 `AGENTS.md`。没有 `/context/ticket.md`。
2. 执行 `git merge <defaultBranch>`，解决冲突，保留两边的意图。
3. 提交前按 `/context/run.json` 的 `gate` 逐条跑通，再提交。`setup` 只列出来，不要求你自己再跑。

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
