# 人审意见以平台为准，由 Rework 修改，不重跑审查

人在控制塔审查页写下 Review comment（人审意见），平台是这些意见的权威来源；托管上只放一条平台维护的汇总评论存档。一次提交是一次 Change request（修改要求）：需求进入 finalizing，每个有意见的仓库跑一步 Rework（返工运行），只经过门禁和（命中时）Recheck，不重跑 final-review，也不跑 Tidy。审这次改动的人就是写意见的人，「审查只跑一次」不变。Rework 记下的 `conflict` / `known-gap` 不经 Spec 轴裁定，直接作为待人定的事列进验收包。有过已提交人审意见的需求不再自动合并；托管上的汇总评论是 bot（或 GitLab 上令牌本人）写的，不算进 `humanComments`。导读只用平台已有的记录（运行的 summary、决定、验收标准、Finding、逐行归属）拼出，不为它跑 agent。

## Considered Options

- **意见以托管为准**：要个人身份、逐条同步成行内讨论、失败对账。现在只有一个人用，GitHub 免费账号的私有仓库没有分支保护，批准没有约束力；单人使用时收益小。
- **意见自动生成追加票**：要多一种写票的 agent 运行，一条小意见也要跑完整个票流水线和重新收尾。涉及新行为、契约或跨仓库的，人用追加票更合适。
- **修改要求重跑 final-review**：等于第二次审查，也会把 Rework 的决定再丢给 Spec 轴；人马上就会看。
- **用 LLM 生成导读**：多一次花钱的运行，要校验它说的位置是否存在，解释也不比当时改代码的 agent 更可信。

## Consequences

- `design.md` 里「PR 上人写的评论可以拉回来返工」（分支 `rework/<slug>-<n>`、需求进 reworking、再逐条回评论）作废，改成本决定。
- 这是 [ADR 0010](0010-afk-means-do-not-wait.md) 的例外：Rework 没有 Spec 轴，缺 Ruling 不是 `invalid-output`。票级和需求级审查仍然缺结论就失败。
- 自动合并的否决从「PR 上有人评论」扩到「平台上有已提交的人审意见」，以后也不再自动合并（[ADR 0011](0011-the-platform-may-merge-through-one-exit.md) 的条件加一条）。
- 推送出口不变：Rework 分支是 `agent/<id>/S-<n>-rework-<k>`，只允许 `agent/*`、`spec/*`。
- 在平台里合并、用人的身份在托管上提交正式 Review、拉托管上评论的正文，都留到有第二个审查人或分支保护时再做。
- GitHub App 增加 Issues: write，汇总评论用 issue comments（`POST /issues/{n}/comments`），按标记更新同一条。不改用 Pull Request Reviews API：那会留下一条 bot review，和「一条普通汇总评论」不同。`design.md` 原先「不给 Issues」作废这一条。GitLab 仍用 MR notes。
- 意见要求改保护路径或删测试名时，Rework 写成 `declined` + `conflict`，不 `cannot-proceed`。批准只挂在 Ticket 上，Rework 没有票可批准；人看见没处理的意见后再追加票。
