# P8 实测：to-tickets 会不会照 tracker 文档执行 confirm

对应票：[to-tickets 会不会照 tracker 文档执行 confirm](https://github.com/xxh171015/afk-platform/issues/100)。本分支不合并。

## 结论：通过（3/3）

3 次运行都在人答"是"之后执行了 `plat spec confirm S-7`，此前没有执行过 confirm，也没有其他改动父项的调用。to-tickets 原文里的"Do NOT close or modify any parent issue"没有拦住它：tracker 文档写明 confirm 是本 tracker 上发布票的最后一步、不属于 modify parent，模型就照 tracker 文档做了。

| 运行 | 回合 | 拆分 | confirm 出现在 |
| --- | --- | --- | --- |
| 1 | 2 | 2 张票 | 第 2 回合（人答"是"）之后 |
| 2 | 3 | 3 张票 | 第 3 回合（人答"是"）之后 |
| 3 | 3 | 2 张票 | 第 3 回合（人答"是"）之后 |

调用记录见各运行目录下的 `calls.log`，回合内容见 `turn-<k>.txt`（agent 的工具调用和最终回答）。

## 顺带看到的

- **导入的票文件全部合规**：7 个文件都有 `## Parent` 且内容是 S-7，没有 `## Blocked by` 一节（依赖都写在 front matter 的 `blocked_by`），验收行都是单行 `- [ ] `。见 `run-*/imported-tickets/`。
- **导入告警原样展示**：3 次都把 `plat tickets import` 打印的告警原样转给人，然后只问一次"开工吗？"。
- **无头模式会跳过拆分审批**：运行 1 在 `-p` 下把 skill 第 4 步"等人批准拆分"当作已跳过，直接导入了（"Treating the skipped quiz as approval"）。运行 2、3 正常停下等批准。编辑器里有人在场，不会这样；但说明在 `-p` 下跑规划类 skill 不可靠，规划要在编辑器里做。
- **`plat` 没帮助信息时 agent 会到处找文档**：第一次搭建时，桩对 `plat --help` 报错，agent 在 Mac 上的家目录里搜文档，读到了 `~/code/afk-platform` 里过时的 tracker 模板（"A skill never confirms"）。那几次运行已作废，正式的 3 次在容器里跑。真实的 `plat --help` 要能把命令列全。

## 方法

- **环境**：Mac 上的平台沙箱镜像 `sandcastle:afk-platform`（Cursor CLI `2026.10.22-27dcf5f`），`agent -p --trust --output-format stream-json`，模型取 `~/.afk/env` 的 `AFK_MODEL`，不加 `--force`；权限由 `.cursor/cli.json` 只放开读、写、`plat`、`ls`、`cat`、`mkdir`、`git`。容器里只挂演练仓库、skills（Mac 上的 `skills@5beb35b`；to-tickets 和固定 SHA `59db609` 逐字相同）和 `plat`。
- **tracker 文档**：`harness/repo/docs/agents/issue-tracker.md`，按冲突清单 P8 一行的写法：导入 → 原样展示告警 → 问一次"开工吗" → 答"是"就 `plat spec confirm` → 告诉人之后只需等验收包、合 PR、看 `plat blocked`；写明 confirm 不改 spec 正文、不关闭 spec，不属于 modify parent。票文件按[平台上票的存储形状](https://github.com/xxh171015/afk-platform/issues/95)的新格式。
- **`plat`**：`harness/bin/plat` 是一个薄客户端，把参数发给 Mac 宿主机上的 `harness/server.py`；后者返回预设的输出并记录每次调用。agent 看得到客户端，看不到服务端。
- **对话**：第 1 回合 `/to-tickets S-7`；skill 请求批准拆分时答"批准，按这个拆。"；问"开工吗"时答"是"。
- **复现**：`harness/serve.sh start <n>`，然后 `harness/turn.sh <n> "<消息>"`，结束后 `harness/serve.sh stop`。
