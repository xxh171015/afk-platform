---
title: 契约：GET /orders 增加 minAmount
repo: backend
type: contract
modules: ["openapi/**"]
blocked_by: []
---

## Parent

S-7

## What to build

调用方打开订单列表契约时，能看到 `GET /orders` 的可选查询参数 `minAmount`：非负整数，单位分。不传该参数表示不过滤。

## Acceptance criteria

- [ ] GET /orders 的契约包含可选查询参数 minAmount
- [ ] minAmount 约定为非负整数，单位分
- [ ] 契约标明不传 minAmount 时不过滤，返回全部订单
