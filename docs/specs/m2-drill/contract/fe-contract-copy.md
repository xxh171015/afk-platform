---
title: "前端：更新契约副本"
repo: afk-pilot-frontend
type: implementation
modules: ["contract/**","src/api/**"]
contract: "contract"
---

## Parent

S-4

## What to build

只更新契约副本并重新生成类型，不改页面。

## Acceptance criteria

- [ ] 契约副本 contract/openapi.yaml 更新为这张票的契约，src/api/schema.d.ts 重新生成
- [ ] 已有测试不减少、不跳过
