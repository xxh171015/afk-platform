# 接入改动随需求进 PR：afk/setup 不单独合入，平台把它叠在集成分支上

afk-setup 给仓库补的接入改动（`.sandcastle/gates.yaml`、tracker 文档、`AGENTS.md`/`CLAUDE.md`、`.gitignore`，以及为跑通门禁改的代码配置）只推到 `afk/setup` 分支，不开 PR。平台切每个 Spec 在这个仓库的集成分支时，先把 `afk/setup` 合到默认分支最新提交上（设置提交），票在它上面开工、按它的 `gates.yaml` 过门禁，接入改动跟着代码在同一个 PR 里进默认分支。规划仓库里，规划提交叠在设置提交之上；人在规划仓库的 `afk/setup` 工作树里规划，那里有规划要读的 tracker 文档，`plat spec confirm` 从这里以 `origin/afk/setup` 为基准发补丁，补丁里只有规划文档的改动。和 [ADR 0005](0005-planning-docs-go-with-the-spec-committed-by-the-platform.md) 同一个理由：需求还没开发，接入改动不该先进默认分支。

> tracker 文档随接入改动进仓库、人在规划仓库的 `afk/setup` 工作树里规划、confirm 以 `origin/afk/setup` 为基准发补丁，这几部分已被 [ADR 0007](0007-planning-instructions-stay-on-the-planning-machine.md) 取代：规划要读的文件只放在规划机器上，人在自己的 checkout 里规划。`afk/setup` 不开 PR、由设置提交随需求进默认分支不变。

## Considered Options

- **开 `afk/setup` PR，合入后才能开工（原做法）**：需求还没开发，接入改动先进了默认分支；人还得先单独审、合一次。
- **接入改动像规划文档一样作为补丁由 `plat spec confirm` 发送**：规划文档只限几个路径，接入改动可能碰任何文件（比如 `vite.config.ts`），补丁就收不住范围；`plat repo check` 也只能检查推上去的分支。
- **设置提交压成一个普通提交（squash）**：丢掉 skill 在提交说明里写的“替换了哪些文件”；合并提交保留它，审 PR 时看得到。

## Consequences

- `afk/setup` 在默认分支包含它之前一直留着：并行的 Spec 都带上它，取消的 Spec 不影响下一个；带着它的 Spec 合入后，之后的集成分支不再有设置提交。平台不推、不删这个分支。
- `afk/setup` 合不进默认分支（有冲突）时，票开工前就失败，报出冲突的文件，让人再跑一次 afk-setup，它会先把默认分支合进 `afk/setup`。
- `plat spec confirm` 的检查改为：默认分支或 `afk/setup` 上有 `gates.yaml` 即可开工；联调 compose 的提醒也看这两处。
- 代价：门禁要到审 Spec 的 PR 时才有人看。在这之前，用的是 agent 写的、只经 `plat repo check` 跑通过的门禁。
- 规划仓库这个 Spec 没有票、但有设置提交时，收尾照样给它开 PR，和只有规划文档时一样。
