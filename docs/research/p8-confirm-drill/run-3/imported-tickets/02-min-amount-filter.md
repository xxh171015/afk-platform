---
title: GET /orders 按金额下限过滤
repo: backend
type: implementation
modules: ["src/**", "test/**"]
blocked_by: [01-contract]
---

## Parent

S-7

## What to build

运营请求 `GET /orders?minAmount=N` 时，只拿到金额不低于 N 分的订单；不传 `minAmount` 时仍拿到全部订单；非法的 `minAmount` 返回 400。行为以 HTTP 接口测试为准。

## Acceptance criteria

- [ ] GET /orders?minAmount=N 只返回 amount 不低于 N 分的订单
- [ ] 不传 minAmount 时 GET /orders 返回全部订单
- [ ] 非法的 minAmount 返回 400
- [ ] 以上行为只通过 GET /orders 的 HTTP 测试覆盖
