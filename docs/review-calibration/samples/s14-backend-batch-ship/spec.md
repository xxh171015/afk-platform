# 订单列表批量发货

## Problem Statement

运营在订单列表里一次处理多张已支付订单时，只能逐个点进详情页再点「发货」，重复操作多、也容易漏单。需要在列表上勾选多张已支付订单，一键发货，并在同一页看到每张订单是否发成。

## Solution

在订单列表增加勾选与「发货」操作：仅已支付订单可勾选，一次最多 100 张；点击后调用新的 `POST /orders/batch-ship`，后端按 ADR「批量发货逐单成立」逐张执行与单张发货相同的状态变更（已支付 → 已发货），返回逐单结果。列表在收到 HTTP 响应后重新加载订单，并在按钮与表格之间展示本次发成/未发成的摘要与明细；进入订单详情再返回时不保留该结果区。订单详情页的单张「发货」行为不变。

## User Stories

1. As 运营, I want 在订单列表勾选多张已支付订单, so that 不用逐个点进详情就能发货。
2. As 运营, I want 列表上只有已支付订单能勾选, so that 不会对不能发货的订单误操作。
3. As 运营, I want 待支付、已发货、已取消的订单行没有勾选框, so that 界面一眼能看出谁能发。
4. As 运营, I want 表头「全选已支付」一次勾选当前列表里全部已支付订单, so that 不用逐行点选。
5. As 运营, I want 当前列表没有任何已支付订单时「全选已支付」不可用, so that 不会出现空操作。
6. As 运营, I want 当前列表里已支付订单超过 100 张时「全选已支付」不可用, so that 不会选中超限数量。
7. As 运营, I want 一次最多勾选 100 张已支付订单, so that 单次批量不会过大。
8. As 运营, I want 已勾选 100 张时其余已支付行的勾选框不可用, so that 不会在界面上选到第 101 张。
9. As 运营, I want 已勾选 100 张时在「发货」旁看到「一次最多发货 100 张」, so that 知道为何不能再选。
10. As 运营, I want 勾选数回到 100 以下后提示消失、其余勾选框恢复, so that 可以继续选单。
11. As 运营, I want 「发货」按钮在未勾选任何订单时不可用, so that 不会误点空提交。
12. As 运营, I want 「发货」按钮在至少勾选一张已支付订单时可用, so that 可以提交批量发货。
13. As 运营, I want 未勾选时不发送批量发货请求, so that 不会产生无意义调用。
14. As 运营, I want 点击「发货」后按钮旁显示「发货中…」且按钮不可用, so that 知道请求进行中且不会重复提交。
15. As 运营, I want 请求结束后「发货中…」消失, so that 界面回到可操作状态。
16. As 运营, I want 批量发货提交的订单编号顺序与列表从上到下一致, so that 结果顺序与表格一致。
17. As 运营, I want 批量发货就是与详情页相同的「发货」（已支付 → 已发货）, so that 业务含义与单张操作一致。
18. As 运营, I want 混选能发与不能发的编号时，能发的照样发成, so that 一张坏单不会挡住其余已支付单（见 ADR 批量发货逐单成立）。
19. As 运营, I want 不存在的订单编号在结果里单独失败且不影响其他张, so that 能看清哪张有问题。
20. As 运营, I want 状态不允许发货的订单在结果里单独失败且错误说明与单张发货相同, so that 原因可对照现有行为。
21. As 运营, I want 合法批量请求无论全部成功、部分成功或全部失败都收到逐单结果, so that 不必猜测哪些发成了。
22. As 运营, I want 批量发货成功后对应订单在列表中显示「已发货」, so that 状态与后台一致。
23. As 运营, I want 批量发货收到 HTTP 响应（成功或 400）后列表自动刷新, so that 行状态以最新数据为准。
24. As 运营, I want 列表刷新后勾选只保留仍在列表中且仍为已支付的订单, so that 已发成的单不会继续留在勾选里。
25. As 运营, I want 在按钮与表格之间看到本次批量结果, so that 不用离开列表就知道发成几张、哪几张失败。
26. As 运营, I want 结果首行显示「发成 N 张，未发成 M 张」, so that 一眼看到汇总。
27. As 运营, I want 结果逐张列出，成功行显示「&lt;编号&gt; 已发货」, so that 能核对每一张成功的单。
28. As 运营, I want 失败行显示「&lt;编号&gt; 」并附上服务端返回的英文 error, so that 能排查原因。
29. As 运营, I want 用「关闭」清掉结果区, so that 界面可以收起来继续操作。
30. As 运营, I want 再次批量发货时用新结果替换旧结果, so that 不会和上一次混在一起。
31. As 运营, I want 点进某张订单详情再返回列表时不再看到上一次批量结果, so that 详情页与列表结果互不干扰。
32. As 运营, I want 网络失败或没有 HTTP 响应时看到「发货失败」, so that 知道这次没完成。
33. As 运营, I want 网络失败时列表仍会重新加载, so that 行状态尽量与服务端一致。
34. As 运营, I want 请求体不合法时看到服务端 error 全文且一张都不发, so that 错误请求不会部分执行。
35. As 运营, I want 在订单详情页仍能用原来的单张「发货」, so that 习惯单张操作的人不受影响。
36. As 运营, I want 已发货订单的状态记录与单张发货相同（多一条 shipped 记录）, so that 详情页状态记录仍然可信。

## Implementation Decisions

### API：`POST /orders/batch-ship`

- 新增契约路径 `POST /orders/batch-ship`（须改后端 OpenAPI；前端契约副本逐字节同步并重新生成类型）。
- 请求体：`{ "ids": string[] }`。额外字段忽略；每个 id 为字符串且**不去**首尾空白。
- 合法 `ids`：长度 1–100，元素均为非空字符串，且**互不相同**。
- 非法 `ids`（含空数组、重复、超限、缺 `ids`、元素非非空字符串等）：**400**，`{ "error": "ids must be 1 to 100 distinct non-empty strings" }`，**不处理任何一张**。
- JSON 解析失败：**400**，`{ "error": "invalid JSON" }`（与现有接口一致）。
- Body 不是 JSON 对象：**400**，`{ "error": "body must be a JSON object" }`（与现有接口一致）。
- 合法请求：**一律 HTTP 200**（含全部逐单失败的情况），响应体：

```json
{
  "results": [
    { "id": "O-1", "ok": true, "order": { /* 发货后的 Order */ } },
    { "id": "O-2", "ok": false, "error": "cannot move from pending to shipped" }
  ]
}
```

- `results` 与请求 `ids` **同序、等长**。
- 处理顺序：按 `ids` 顺序逐张调用与 `POST /orders/{id}/status` 等价的 **已支付 → 已发货** 逻辑（含状态流转校验、404、409 类错误文案、状态记录追加 `{ status: "shipped", at }`）。
- 逐单成立：某张失败不撤回已在本请求中发成的其他张（见 ADR「批量发货逐单成立」）。

### 订单列表 UI

- 在现有订单列表表格增加勾选列；工具栏含「全选已支付」与「发货」。
- 仅 **已支付 (paid)** 行渲染勾选框；其他状态无勾选框。
- 「全选已支付」：无已支付行时禁用；已支付行数 ≤100 时勾选全部已支付；已支付行数 &gt;100 时禁用。
- 勾选上限 100：满 100 时未选中的已支付行勾选框禁用，「发货」旁显示「一次最多发货 100 张」。
- 「发货」：至少勾选 1 张才可点；请求进行中禁用并显示「发货中…」。
- 提交 `ids`：当前列表中**已勾选**的订单，按表格**从上到下**顺序。
- 响应处理：
  - 收到 HTTP 响应（200 或 400）：解析结果区；**始终**再请求 `GET /orders` 刷新列表；刷新后勾选仅保留仍在列表且仍为 paid 的 id。
  - 200：结果区 `role="status"`，首行「发成 N 张，未发成 M 张」（N/M 由 `results` 统计），逐张明细；可「关闭」。
  - 400：结果区 `role="alert"`，显示 `{ "error" }` 原文。
  - 无 HTTP 响应：`role="alert"` 显示「发货失败」，并同样刷新列表。
- 结果区位于「发货」按钮与表格之间；只保留最近一次；进入详情页导致列表卸载，返回后不恢复结果区。

### 模块与仓库

- **Backend**：路由、校验、批量发货编排（复用现有 store 状态变更）、OpenAPI、HTTP 测试与契约测试。
- **Frontend**：契约副本与生成类型、`OrderList` 交互与展示；继续通过 openapi-fetch client 调用 API；详情页 `OrderDetail` 不改为批量路径。

### 领域文档

- 术语见仓库 `GLOSSARY.md`（发货、批量发货、已支付、已发货）。
- 架构取舍见 `docs/adr/0001-batch-ship-per-order.md`。

## Testing Decisions

**什么是好测试**：只断言对外可观察行为（HTTP 状态码、响应体形状与文案、列表 DOM 与可访问角色/文案），不断言内部函数调用顺序或私有状态。

**测试接缝（请确认是否符合预期）**：

1. **Backend HTTP（主接缝 — API）**  
   通过现有 `startApp()` 辅助起真实 HTTP 服务，在 `test/orders.test.ts` 覆盖 `POST /orders/batch-ship`：合法/非法 body、逐单成功与失败组合、`results` 顺序、与单张发货相同的 error 文案、发成后 `GET /orders` 与 `GET /orders/{id}/history` 的副作用。  
   在 `test/contract.test.ts` 为 `POST /orders/batch-ship` 增加契约符合性请求（与现有 `POST /orders/{id}/status` 做法相同）。  
   *Prior art*：`test/orders.test.ts` 里单张 status 与列表过滤测试；`test/contract.test.ts` 里按路径补 operation 并 `expectConforms`。

2. **Frontend 订单列表组件（主接缝 — 列表 UX）**  
   在 `OrderList` 的组件测试里用 MSW（`src/test/mocks.ts` 的 `http`）模拟 `GET /orders` 与 `POST /orders/batch-ship`：勾选规则、全选/上限 100、「发货」与「发货中…」、结果区文案与关闭、400/200 后是否触发重新拉列表、勾选在刷新后的收敛。  
   *Prior art*：`OrderList.test.tsx` 现有加载与点击编号测试；`OrderDetail.test.tsx` 里对 status 操作的 MSW 模式。

**刻意不用作门禁接缝**：Playwright e2e（`npm run e2e`）依赖联调环境，日常门禁不跑；本 spec 不强制新增 e2e，除非后续单独加 integration 票。

## Out of Scope

- 运单号、承运商、仓库、物流跟踪。
- 批量取消、批量改价、批量改备注。
- 列表分页、排序、筛选变更（沿用现有 `GET /orders` 行为）。
- 改动详情页单张「发货」的实现路径。
- 整批原子回滚（「一张失败全部不发」）；已明确采用逐单成立。
- 非 200/400 的 HTTP 错误专用文案（除「发货失败」与现有 error 体外不做扩展）。
- 修改 seed 客户名或联调 compose（除非 integration 票另定）。

## Further Notes

- 契约变更须走 **contract 票**（或带 `protected_paths_ok` 的实现票），前端 `contract/openapi.yaml` 与生成物一并提交。
- 实现票宜拆为：契约 → 后端实现 → 前端实现（前端 `contract` 边指向契约票）。
- Grill 会话中新增的 `GLOSSARY.md` 与 ADR 应在 `plat spec confirm` 时随 spec 集成分支提交（保持工作区未 push，由平台处理）。

