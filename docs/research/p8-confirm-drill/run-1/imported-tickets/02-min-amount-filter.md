---
title: GET /orders 按金额下限过滤
repo: backend
type: implementation
modules: ["src/orders/**", "test/**"]
blocked_by: [01-contract]
---

## Parent

S-7

## What to build

运营拉取订单列表时，带上 `minAmount` 只看到金额不低于该值的订单；不带该参数时仍看到全部订单。传入非法下限时接口返回 400，便于调用方发现参数传错。只通过 HTTP 的 GET /orders 验证。金额上限和排序不做。

## Acceptance criteria

- [ ] GET /orders?minAmount=N 只返回 amount >= N 的订单
- [ ] GET /orders 不带 minAmount 时返回全部订单
- [ ] 非法的 minAmount 返回 400
