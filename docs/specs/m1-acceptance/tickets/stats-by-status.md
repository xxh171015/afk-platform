---
title: "统计里增加按状态分组"
repo: backend
type: implementation
modules: ["src/orders/**","test/**"]
blocked_by: [note-field]
---
## Parent

S-1

## What to build

不改契约文件。

## Acceptance criteria

- [ ] GET /orders/stats 的响应里增加 byStatus，格式是 { pending, paid, shipped, cancelled }，每项是 { count, total }
- [ ] 原有的 count、total、totalFormatted 保持不变（仍然不含已取消订单）
- [ ] 没有订单时 byStatus 里每一项都是 { count: 0, total: 0 }
- [ ] 每条验收标准都有对应的 HTTP 测试
