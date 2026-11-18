# 阶段：final-tidy

这是需求收尾时按 Standards 轴建议做的**一次整理**：只做不改变行为的改动。失败会被丢掉，不要为了交差去改测试或配置。

1. 读 `/context/review.json` 里 Standards 轴的 `suggestions`（`standards.suggestions`）、`/context/spec.md`、`/context/tickets.md`（需求背景，以及每张票的验收标准，整理完后它们都必须还成立）、`/context/run.json` 和仓库根目录的 `AGENTS.md`。
2. 当前分支就是从集成分支切出来的，在上面改。只挑改动小、局部、不改变行为的建议去做。**不改已有测试和配置，不改测试名。** 不要为建议补新测试。不读 tdd（行为不变，没有新测试）。
3. 提交前按 `/context/run.json` 的 `gate` 逐条跑通。`setup` 只列出来，不要求你自己再跑。没有值得做的建议就不要提交。
4. 结果里 `tidied` 是你处理了的 suggestions 下标（从 0 起），没做的写进 `skipped` 并写原因。

## 结果

```
<result>
{
  "status": "done",
  "summary": "一两句话说整理了什么",
  "tidied": [0],
  "skipped": [{ "index": 1, "reason": "会改到已有测试" }],
  "decisions": []
}
</result>
```

做不了或不该做时改成：

```
<result>
{
  "status": "cannot-proceed",
  "blockedReason": "agent-gave-up",
  "detail": "卡在哪里、需要什么"
}
</result>
```

`summary` 是一句字符串。`tidied` 是从 0 起的整数的数组。`skipped` 是对象数组，每项 `{ "index", "reason" }`，`reason` 是一句字符串。`decisions` 是对象数组，每项 `{ "kind", "text" }`，只有 `kind` 是 `deferred` 时才带 `ref`（T-n 或 `new`）。`blockedReason` 只能是 `agent-gave-up` 或 `contract-change-needed`，`detail` 是一句字符串。
