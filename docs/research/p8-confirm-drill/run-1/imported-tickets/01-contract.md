---
title: 订单列表契约增加 minAmount
repo: backend
type: contract
modules: ["openapi/**"]
blocked_by: []
---

## Parent

S-7

## What to build

订单列表接口对外声明可选的金额下限：调用方可以传 `minAmount`（非负整数，单位分），也可以不传。不传表示列表不受金额下限约束。金额上限和排序仍不在契约里。

## Acceptance criteria

- [ ] GET /orders 声明可选查询参数 minAmount
- [ ] minAmount 为非负整数，单位分
- [ ] minAmount 可省略，省略表示不按下限过滤
