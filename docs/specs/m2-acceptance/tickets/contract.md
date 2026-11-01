---
title: "契约：取消订单必须带原因，状态记录带上原因"
repo: afk-pilot-backend
type: contract
modules: ["openapi/**"]
protected_paths_ok: ["openapi/openapi.yaml"]
---
## Parent

S-1

## What to build

只改契约，不改代码。

## Acceptance criteria

- [ ] POST /orders/{id}/status 的请求体增加可选字段 reason（字符串，1 到 200 个字符）；描述写明 status 为 cancelled 时必须带 reason，否则返回 400
- [ ] GET /orders/{id}/history 的每一项增加可选字段 reason（字符串），只在取消那一项出现
- [ ] 现有接口的其他描述不变
