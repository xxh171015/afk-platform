# PROTOTYPE：M0 完整单票流水线

一次性原型（分支 `prototype/m0-pipeline`，不合并）。把试点仓库里的一张票无人值守地合进集成分支，按 `docs/design.md`「单票执行流水线」走。有用的部分以后会搬进 M1 的 worker。

## 文件

- `run-ticket.ts`：主流程（状态流转、各种 fix 的次数上限、blocked 原因码）
- `pipeline/stages.ts`：各阶段函数：渲染 `/context`、补 trailer、保护路径检查、门禁、`merge-tree` 候选
- `pipeline/sandbox.ts`：**唯一**调用 Sandcastle 的模块（agent 运行、在新沙箱里跑命令、丢弃未提交改动）
- `pipeline/config.ts`：路径、凭据、git 和 push 工具、结构化输出的 zod schema
- `prompts/implement.md`、`fix.md`、`review.md`：只放指针的 AFK prompt

## 在 Mac 上跑

```sh
cd ~/code/afk-platform
git fetch origin prototype/m0-pipeline && git checkout prototype/m0-pipeline
cd m0 && npm ci
export M0_SKIP_BUILD=1   # 镜像第一天已经构建过；没有 day-one 的镜像就去掉这行并先跑一次 node day-one.ts
```

三条路径，各自独立（每次都新建一个 `spec/m0p-<时间>` 集成分支并推到试点仓库的 origin）：

```sh
# A 正常路径：T-001
node run-ticket.ts --ticket T-001 --probe-git

# B gate-fix：T-001 做完后，脚本故意在分支上加一个 tsc 错误，让 gate-fix 去修
node run-ticket.ts --ticket T-001 --sabotage

# C 保护路径：T-003 的验收标准要求改 openapi/openapi.yaml，预期 BLOCKED protected-path-changed
node run-ticket.ts --ticket T-003
```

每次大约 5–15 分钟（A 要两次 agent 运行：implement + review）。最后打印"结果"和时间线。

## 它会做什么、不会做什么

会：在你的 Mac 上起沙箱、调用 Cursor（用额度）、往试点仓库 origin 推 `agent/*`、`spec/*` 分支（用 `~/.afk/env` 里的 token）。
不会：改 `main`、开 PR、碰别的仓库。
结果和日志：`~/.afk/m0-pipeline/<run-id>/`（`report.json`、各阶段日志、门禁日志和 JUnit、`git-probe.json`）。

`MODEL` 同样用 `M0_MODEL`（默认 `auto`）。
