---
title: "前端：订单详情页的状态操作和取消原因"
repo: afk-pilot-frontend
type: implementation
modules: ["src/**","contract/**"]
contract: contract
---
## Parent

S-1

## What to build

调后端只用生成的 client，mock 只用 openapi-msw。e2e 不在这张票里写，由联调票写。

## Acceptance criteria

- [ ] 契约副本 contract/openapi.yaml 更新为这张票的契约，src/api/schema.d.ts 重新生成
- [ ] 订单详情页按当前状态显示可用的操作：待支付显示「支付」「取消」，已支付显示「发货」「取消」，已发货和已取消不显示操作
- [ ] 点「取消」弹出输入框填原因，原因为空时不能提交；提交后页面显示更新后的订单和状态记录
- [ ] 状态记录里取消项显示原因
- [ ] 后端返回 400 或 409 时，页面显示后端给的错误信息
- [ ] 每条验收标准都有组件测试（openapi-msw 的 mock），已有测试不减少、不跳过
