# M1 验收需求二：订单状态历史

第一份验收需求「订单备注」（[m1-acceptance/](../m1-acceptance/)）已合进试点仓库 main。平台后来又改了 #45–#58，所以用这份新需求在 `afk-pilot-backend` 上重跑一遍 M1 验收。

- 需求说明：[spec.md](spec.md)（`plat spec create --file`）
- 票：[tickets.yaml](tickets.yaml)

## 依赖图

```
contract ─┬─► updated-at ─┬─► history-endpoint   （history-endpoint 同时依赖 contract 和 updated-at，且用契约 SHA）
          │               └─► stats-last-updated
          └──────────────────► history-endpoint
pagination                                        （独立，没有依赖）
```

## 有意覆盖的机制

| 票 | 覆盖 |
| --- | --- |
| contract | 已批准的保护路径（`openapi/openapi.yaml`）、契约 SHA |
| updated-at、history-endpoint、stats-last-updated | 依赖链、只在依赖都 done 后才开工 |
| pagination | 没有依赖，和其他票并行；与另三张实现票模块重叠，导入时应产生告警 |
| history-endpoint | `contract` 边（使用固定的契约 SHA） |

导入时预期的告警：`pagination` 与 `updated-at`、`history-endpoint`、`stats-last-updated` 模块重叠且没有依赖路径；`history-endpoint` 与 `stats-last-updated` 模块重叠且没有依赖路径。确认拆分时由人决定放行。

## 运行方式

在 Mac 上用独立的库 `afk_acc`、`AFK_HOME=~/.afk-acc`、API 端口 3100 跑，不碰日常用的 `afk` 库。人只做开头（建项目、建需求、导入、确认拆分）和最后合并 PR。

## 通过标准

见 [m1-platform.md](../m1-platform.md)「验收需求」。

## 验收记录（2026-10-30，Mac，模型 `cursor-grok-4.6-xhigh`）

**结论：通过，但中途有一次人工介入**（重启 worker，原因是平台 bug #60，已修）。如果要一次严格的「人只在首尾出现」，需要用修好的代码再跑一遍。

| 项 | 结果 |
| --- | --- |
| 导入 | 5 张票，4 条模块重叠告警，与上面预期一致；人确认拆分后放行 |
| 运行 | 03:02 确认 → 04:07 PR 开出（UTC），约 65 分钟；agent 用时合计 4393 s |
| 票 | 5 张都 done，各一次 implement、review、merge；T-1 与 T-4 并行，T-2/T-3/T-5 在依赖 done 后才开工 |
| fix 被自然触发 | T-2 第一次门禁失败：测试数 63 < 基线 66（T-2 开工时 T-4 还没合并）；gate-fix 合入集成分支后 79 个测试，门禁通过 |
| 契约 | T-1 只改了 `openapi/openapi.yaml` 和 `test/openapi.test.ts`，保护路径按票批准；契约 SHA 是 T-1 的合并提交 `903d688`，T-3 经 `contract` 边使用它 |
| 可追溯 | 23 个 Run 都有记录（stage、attempt、model、耗时、commits），每个 Run 都有日志；11 次门禁结果都有测试数，跳过数都是 0；PR 上每个 agent 提交都带 `Spec:/Ticket:/Run:`，合并提交带 `Ticket:` |
| 收尾 | final-review 通过；GitHub App 开出 [afk-pilot-backend#10](https://github.com/xxh171015/afk-pilot-backend/pull/10)，可合并 |
| 验收包 | 已生成：29 条验收标准全部 verified（对到 JUnit 用例），review 建议 16 条、不确定项 2 条进了验收包，最终门禁 86 个测试、0 跳过 |
| 合并 | 由人合并 |

运行中遇到的问题：

- **#60（已修，177af42）**：GitHub 临时不可达导致一个作业失败后，worker 领下一个作业时又遇到连接重置，异常没接住，整个 worker 退出，另一个槽位上的作业也断了。修复后重启 worker；两个作业等租约过期后以 attempt 2 重新派发，worker 接管了旧的槽位锁，结果正常。之后又有两次 GitHub 连不上（`git fetch` 75 s 超时），作业失败后由平台自动重派，没有人介入。
- **#61（未修）**：API 的运行日志目录默认是 `~/.afk/logs`，不跟库走。这次没设 `AFK_LOG_DIR`，验收的日志追加进了日常库同编号 Run 的日志文件。
- 小瑕疵：网络错误在 worker 日志里被标成 `unexpected error`，读起来比实际严重。
