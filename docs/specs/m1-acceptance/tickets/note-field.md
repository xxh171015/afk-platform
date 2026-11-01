---
title: "订单增加备注字段"
repo: backend
type: implementation
modules: ["src/orders/**","test/**"]
blocked_by: [contract]
---
## Parent

S-1

## What to build

按契约实现，不要修改契约文件。

## Acceptance criteria

- [ ] POST /orders 接受可选的 note（字符串，去掉首尾空白，最长 200），超长返回 400，错误信息是 "note must be at most 200 characters"
- [ ] 订单响应在有备注时包含 note，没有时不出现该字段
- [ ] GET /orders 和 GET /orders/:id 返回的订单都带上 note
- [ ] 每条验收标准都有对应的 HTTP 测试，已有测试不减少、不跳过
