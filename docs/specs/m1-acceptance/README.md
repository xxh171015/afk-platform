# M1 验收需求：订单备注

M1 的验收用这个需求在试点仓库 `afk-pilot-backend` 上跑一遍。票文件：目录 [tickets/](tickets/)，一张票一个 markdown 文件。

## 依赖图

```
contract ─┬─► note-field ─┬─► patch-note        （patch-note 同时依赖 contract 和 note-field）
          │               └─► stats-by-status
          └──────────────────► patch-note
filter-customer                                  （独立，没有依赖）
```

## 有意覆盖的机制

| 票 | 覆盖 |
| --- | --- |
| contract | 已批准的保护路径（`openapi/openapi.yaml`）、契约 SHA |
| note-field、patch-note、stats-by-status | 依赖链、只在依赖都 done 后才开工 |
| filter-customer | 没有依赖，和其他票并行；与 note-field / patch-note / stats-by-status 的模块范围重叠，导入时应产生告警 |
| patch-note | `contract` 边（下游票使用固定契约 SHA） |

导入时预期的告警：`filter-customer` 与 `note-field`、`patch-note`、`stats-by-status` 模块重叠且没有依赖路径；`patch-note` 与 `stats-by-status` 模块重叠且没有依赖路径。确认拆分时由人决定放行。

## 通过标准

见 [m1-platform.md](../m1-platform.md)「验收需求」。
