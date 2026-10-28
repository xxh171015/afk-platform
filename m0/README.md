# PROTOTYPE：M0 第一天四项验证

一次性脚本，不进 main，只回答一个问题：Cursor Agent CLI + Sandcastle 0.12.0 + 试点仓库，在 Mac 上能不能把一张真实的票跑到"有 commit、有结构化输出、门禁通过"。验证完成后，有用的部分会改写进 M0 完整流水线。

## 在 Mac 上跑

```sh
cd ~/code/afk-platform
git fetch origin prototype/m0-day-one
git checkout prototype/m0-day-one
cd m0
npm ci
node day-one.ts            # 第一次要构建镜像，几分钟；然后跑一次 agent，十几分钟
```

可选环境变量：`M0_MODEL`（默认 `auto`）、`M0_SKIP_BUILD=1`（镜像已构建过）、`M0_BASELINE_TESTS`（默认 17）。

它会做什么：构建沙箱镜像 → 在容器里跑 `agent --version` / `agent models` → 渲染 `/context` → 用试点仓库的 T-001 跑一次 implement（一次 agent 运行）→ 另起一个新沙箱跑门禁 → 打印四项验证结果。

不会 push，不会动 `main`。会在试点仓库里留下本地分支 `spec/m0d1-<时间>` 和 `agent/T-001-<时间>`。

## 结果在哪

`~/.afk/m0-day-one/<run-id>/`：`report.json`（四项结果 + 备注）、`agent.log`、`stream-raw.jsonl`（agent 的原始 stream-json）、`stdout.txt`、`gate-*.log`、`junit.xml`、`preflight-*.txt`。把终端最后打印的"结果"那一段贴回来就行。

## 已知的简化

- 只测一张票、一次 agent 运行；不测 gate-fix、review、合并（那是下一张票）
- 结构化输出用顶层 `run()` 的 `Output.object`；同时用自己的提取逻辑对照一遍（方案 B 备选）
- 门禁配置从基准提交读，格式是草案
