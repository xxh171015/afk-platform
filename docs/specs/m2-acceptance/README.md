# M2 验收需求：订单状态操作与取消原因

M2 的验收用这个需求在两个试点仓库 `afk-pilot-backend`、`afk-pilot-frontend` 上跑一遍。票文件：[tickets.yaml](tickets.yaml)。

## 依赖图

```
afk-pilot-backend                         afk-pilot-frontend
contract ──blocks──► be-cancel-reason ──────────┐
   │                                            ▼
   └──contract（跨仓库）──► fe-status-actions ──► e2e（integration，environment: [afk-pilot-backend]）
```

前后端实现票在契约票 done 后并行；联调票等两边都 done。

## 有意覆盖的机制

| 票 | 覆盖 |
| --- | --- |
| contract | 已批准的保护路径（`openapi/openapi.yaml`）、契约 SHA |
| be-cancel-reason | 同仓库的 blocks 边；后端门禁的 `contract`（`validate-api`）和契约测试 |
| fe-status-actions | **跨仓库的 contract 边**：`/context/contract/afk-pilot-backend/` 送到前端票；契约副本检查；和后端票并行 |
| e2e | 联调票：在环境里写 e2e、merge 后由 worker 跑 e2e、失败时诊断和修复票 |
| 收尾 | 两个仓库各自收尾；有 final-fix 时开 PR 前重跑联调；前端 PR 先开 draft（前端使用后端的契约），后端合并后 `pr-ready` 转 ready；`partially-merged` → `merged` |

状态流转（待支付 → 已支付 → 已发货，任何时候可取消；后端对非法流转返回 409）是前后端最容易理解不一致的地方，比较可能自然触发一次修复票。

导入时预期没有模块重叠告警（前后端在不同仓库，同仓库的票之间都有依赖路径）。

## 通过标准

见 [m2-platform.md](../m2-platform.md)「验收需求」。
