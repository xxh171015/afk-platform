# 阶段：merge-fix

集成分支在这张票之外前进了，或者合并后的门禁失败了（日志在 `/context/failure/gate.log`，如果有）。这个阶段不读 skill，只用覆盖层。

1. 读 `/context/run.json`：`integrationBranch` 是集成分支。再读 `/context/ticket.md` 弄清这张票的意图，以及仓库根目录的 `AGENTS.md`。
2. 执行 `git merge <integrationBranch>`，解决冲突，保留两边的意图。
3. `npm run typecheck` 和 `npm test` 都要通过，再提交。

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
