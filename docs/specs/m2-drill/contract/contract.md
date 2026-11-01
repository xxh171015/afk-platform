---
title: "契约：订单详情的描述提到取消原因"
repo: afk-pilot-backend
type: contract
modules: ["openapi/**"]
protected_paths_ok: ["openapi/openapi.yaml"]
---

## Parent

S-4

## What to build

只改契约的一处描述，不改代码。

## Acceptance criteria

- [ ] GET /orders/{id}/history 的 description 末尾加一句：已取消的订单，状态记录里带取消原因
- [ ] 只改这一处描述，其他不变
