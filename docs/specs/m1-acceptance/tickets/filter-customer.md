---
title: "按客户过滤订单列表"
repo: backend
type: implementation
modules: ["src/orders/**","test/**"]
---
## Parent

S-1

## What to build

在已有的订单列表接口上加一个可选查询参数。不改契约文件（契约的同步由单独的契约票处理）。

## Acceptance criteria

- [ ] GET /orders?customer=alice 只返回 customer 精确等于 alice 的订单（区分大小写），顺序仍按创建顺序
- [ ] 可以和 status 过滤同时使用，两个条件取交集
- [ ] customer 为空字符串时返回 400，错误信息是 "customer must not be empty"
- [ ] 不带 customer 时行为不变
- [ ] 每条验收标准都有对应的 HTTP 测试
