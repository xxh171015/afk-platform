---
title: "后端：取消订单记录原因"
repo: afk-pilot-backend
type: implementation
modules: ["src/orders/**","test/**"]
blocked_by: [contract]
---
## Parent

S-1

## What to build

按契约（契约 SHA 上的版本）实现，不要修改契约文件。

## Acceptance criteria

- [ ] POST /orders/:id/status 带 { status: "cancelled", reason } 时成功，状态记录的取消项带上 reason（去掉首尾空白）
- [ ] status 为 cancelled 但没有 reason、reason 为空或超过 200 个字符时返回 400，错误信息是 "reason is required to cancel (1-200 characters)"
- [ ] status 不是 cancelled 时忽略 reason，状态记录里不出现 reason
- [ ] 契约测试（test/contract.test.ts）覆盖带原因的取消和状态记录
- [ ] 每条验收标准都有对应的 HTTP 测试，已有测试不减少、不跳过
