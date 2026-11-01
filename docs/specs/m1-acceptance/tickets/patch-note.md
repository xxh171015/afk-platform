---
title: "修改订单备注"
repo: backend
type: implementation
modules: ["src/orders/**","test/**"]
blocked_by: [contract, note-field]
contract: contract
---
## Parent

S-1

## What to build

按契约（契约 SHA 上的版本）实现。

## Acceptance criteria

- [ ] PATCH /orders/:id 请求体 { "note": "..." }，成功返回 200 和更新后的订单
- [ ] note 为空字符串时清除备注（响应里不再有 note）
- [ ] 订单不存在返回 404，note 不是字符串或超长返回 400
- [ ] 已取消（cancelled）的订单不允许修改备注，返回 409，错误信息是 "cannot edit a cancelled order"
- [ ] 每条验收标准都有对应的 HTTP 测试
