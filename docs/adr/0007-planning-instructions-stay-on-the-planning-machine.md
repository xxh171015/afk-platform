# 规划要读的文件只放在规划机器上，不进仓库

规划用的 skill 要读到 tracker 文档、`docs/agents/domain.md`、`docs/agents/triage-labels.md`，还要有 `## Agent skills` 一节告诉它们去哪里找。这些只在规划时用，平台执行票时一样都不读。所以 afk-setup 把它们写在每台规划机器上那份规划仓库的 checkout 里，全部登记到这个仓库的 `.git/info/exclude`，不提交：
- tracker 文档和 `docs/agents` 下的两个文件，就放在原来的路径；
- `## Agent skills` 一节不再写进 `AGENTS.md` 或 `CLAUDE.md`，改写进只在本机生效的规则文件：Claude Code 读的 `CLAUDE.local.md`，Cursor 读的 `.cursor/rules/afk-platform.mdc`（`alwaysApply`）。

这样，人在自己的 checkout、任意分支上，接入之后马上就能规划；`git status` 始终是干净的；confirm 不需要替这些文件做什么，事后也没有要清理的东西。

`afk/setup` 里只留执行时 agent 要读的东西：`.sandcastle/gates.yaml`、`AGENTS.md` 里"怎么跑测试"和"无人值守运行"两节，以及为跑通门禁改的代码配置。

本篇取代 [ADR 0006](0006-setup-goes-with-the-spec.md) 里"tracker 文档随接入改动进仓库、人在规划仓库的 `afk/setup` 工作树里规划、confirm 以 `origin/afk/setup` 为基准发补丁"的部分。0006 其余部分不变：`afk/setup` 不开 PR，由设置提交随需求进默认分支。

## Considered Options

- **在 `afk/setup` 工作树里规划（0006 的做法）**：人要换到 `<规划仓库>-afk-setup` 目录去规划，直到第一个需求合入后才能回到自己的 checkout；worktree 和本地分支要人自己删。
- **把这些文件写进 checkout 但不提交，confirm 时当规划文档发出去，发完 stash 掉**：整个规划期间 `git status` 都显示有改动，人容易把它们顺手提交进自己的代码；最后还会留下一个 stash。
- **`AGENTS.md` 里加一行指引，再用 `skip-worktree` 把这处改动藏起来**：之后拉取到对 `AGENTS.md` 的改动时会出错，人不明白为什么。留作 Cursor 不认被忽略的规则文件时的退路。

## Consequences

- 每台规划机器各自运行一次 `/afk-setup` 来生成这些文件。第二个人加入一个已经接入的项目时，afk-setup 只做本机这部分（工具、skill、本机的规划文件），不推送，也不重跑门禁检查。
- tracker 文档过期时（项目加了仓库、平台升级），afk-setup 在本机重写它，不经过 `afk/setup`。
- 已经把 tracker 文档、`## Agent skills` 提交进仓库的项目保持原样：被跟踪的照旧在仓库里，照旧通过 `afk/setup` 更新。afk-setup 不主动删除它们。
- 前提：Cursor 会加载被 `.git/info/exclude` 忽略的 `.cursor/rules/*.mdc`（`alwaysApply`），已在 Cursor 里实测可行（#174）；Claude Code 读被忽略的 `CLAUDE.local.md` 也已实测可行。
- afk-setup 不再保留 `<规划仓库>-afk-setup` 工作树。
