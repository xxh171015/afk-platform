---
title: "联调：已发货的订单没有操作按钮"
repo: afk-pilot-frontend
type: integration
modules: ["e2e/**"]
environment: ["afk-pilot-backend"]
---

## Parent

S-2

## What to build

在联调环境里写 e2e，对着真后端跑通再提交。会改状态的测试先通过 /api 新建自己的订单再操作，不要改动别的测试依赖的种子订单。

## Acceptance criteria

- [ ] e2e：把一个新建的订单依次支付、发货之后打开它的详情页，页面不显示「支付」「发货」「取消」按钮
- [ ] 已有的 e2e 不减少、不跳过
