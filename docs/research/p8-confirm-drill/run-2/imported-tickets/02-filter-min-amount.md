---
title: GET /orders 按金额下限过滤订单
repo: backend
type: implementation
modules: ["src/orders/**", "test/**"]
blocked_by: [01-contract]
---

## Parent

S-7

## What to build

运营调用 `GET /orders?minAmount=N` 时只看到金额不低于 N 分的订单；不传 `minAmount` 时仍看到全部订单，原来的列表用法不受影响。行为只通过 HTTP 接口验证。

## Acceptance criteria

- [ ] GET /orders?minAmount=N 只返回 amount 不低于 N 的订单
- [ ] 不传 minAmount 时 GET /orders 仍返回全部订单
- [ ] 以上行为有 GET /orders 的 HTTP 测试覆盖
