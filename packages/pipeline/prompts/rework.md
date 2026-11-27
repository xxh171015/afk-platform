# 阶段：rework

这是一次**修改要求**下对本仓库集成分支的返工：读人审意见，逐条处理，只改意见需要的地方。

1. 读 `/context/review-comments.json`（这次修改要求里本仓库的意见；`comments` 的每个 `id` 都要处理）、`/context/spec.md` 和 `/context/tickets.md`（需求背景，以及每张票的验收标准，改完后它们都必须还成立）、`/context/run.json`（集成分支的名字和基准提交）和仓库根目录的 `AGENTS.md`。有 `/context/failure/cases.json` 就读：那是合并后门禁重跑后仍失败的用例。
2. 当前分支就是从集成分支切出来的，在上面改，只改意见需要的地方，改动要小。不要重跑审查，也不要做 Tidy。
3. `writtenOn` 和 `currentHead` 不同的意见，先在当前代码里找到 `excerpt` 对应的位置；找不到、或者那段代码已经变得意见不再适用，就写成 `declined` 并说明。
4. 意见改变行为的，读 `/home/agent/.cursor/skills/tdd/SKILL.md`，照它修：先写一个**会失败的测试**，再修到它通过；只做红 → 绿，不重构。只是命名、注释、文档的，不必硬写测试。不要读 `diagnosing-bugs`。
5. 意见和需求、契约或现有测试冲突的，不改，写成 `declined` 并说明原因，同时写一条 `conflict` 决定。意见要求改保护路径或删测试名（包括改已有测试的名字）的，同样不改，写成 `declined`，决定里带 `conflict`，说明要追加票并批准；不要 `cannot-proceed`。
6. 提交前：若有 `/context/failure/cases.json`，先只跑它列出的文件，修好后再按 `/context/run.json` 的 `gate` 逐条跑通。没有这个文件就只按 `gate` 逐条跑。`setup` 只列出来，不要求你自己再跑。

## 结果

```
<result>
{
  "status": "done",
  "summary": "一两句话",
  "comments": [
    { "id": "C-12", "outcome": "addressed", "reply": "空列表返回 200 和 []，加了测试 list returns empty array" },
    { "id": "C-14", "outcome": "declined", "reply": "迁移已经用 IF NOT EXISTS，重复跑不会出错；没有改" }
  ],
  "acceptance": {},
  "decisions": []
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

`summary` 是一句字符串。`comments` 必须正好覆盖 `/context/review-comments.json` 里的每个 `id`，每项 `{ "id", "outcome", "reply" }`，`outcome` 只能是 `addressed` 或 `declined`，`reply` 是一句字符串。`acceptance` 的值是测试名字符串的数组。`decisions` 是对象数组，每项 `{ "kind", "text" }`，只有 `kind` 是 `deferred` 时才带 `ref`（T-n 或 `new`）。`blockedReason` 只能是 `agent-gave-up` 或 `contract-change-needed`，`detail` 是一句字符串。
