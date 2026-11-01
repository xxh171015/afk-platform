---
title: "契约：订单备注字段和修改备注接口"
repo: backend
type: contract
modules: ["openapi/**"]
protected_paths_ok: ["openapi/openapi.yaml"]
---
## Parent

S-1

## What to build

只改契约，不改代码。note 缺省时表示没有备注（响应里该字段可以不出现）。

## Acceptance criteria

- [ ] openapi.yaml 的 Order 和 NewOrder 里有可选字符串字段 note，最长 200 个字符
- [ ] openapi.yaml 里有 PATCH /orders/{id}，请求体是 { note }，成功返回更新后的订单，订单不存在返回 404，note 超长返回 400
- [ ] 现有接口的描述不变
