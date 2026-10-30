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
