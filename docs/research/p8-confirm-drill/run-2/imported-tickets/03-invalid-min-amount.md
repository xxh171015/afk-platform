---
title: 非法 minAmount 返回 400
repo: backend
type: implementation
modules: ["src/orders/**", "test/**"]
blocked_by: [02-filter-min-amount]
---

## Parent

S-7

## What to build

API 使用方给 `GET /orders` 传入非法的 `minAmount`（负数、非整数、无法当成数字）时得到 400，而不是一份过滤错的订单列表。行为只通过 HTTP 接口验证。

## Acceptance criteria

- [ ] minAmount 为负数时 GET /orders 返回 400
- [ ] minAmount 不是非负整数时 GET /orders 返回 400
- [ ] 以上行为有 GET /orders 的 HTTP 测试覆盖
