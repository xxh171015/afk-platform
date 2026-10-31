---
title: GET /orders 契约增加 minAmount
repo: backend
type: contract
modules: ["openapi/**"]
blocked_by: []
---

## Parent

S-7

## What to build

订单列表契约让调用方知道：`GET /orders` 可以带可选的 `minAmount`（非负整数，单位分），只关心金额不低于它的订单；非法的下限会得到 400。

## Acceptance criteria

- [ ] GET /orders 的契约包含可选查询参数 minAmount
- [ ] minAmount 在契约中是非负整数，单位分
- [ ] 契约写明非法 minAmount 返回 400
