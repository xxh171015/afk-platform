---
title: "联调：状态操作和取消原因"
repo: afk-pilot-frontend
type: integration
modules: ["e2e/**"]
blocked_by: [be-cancel-reason, fe-status-actions]
environment: [afk-pilot-backend]
---
## Parent

S-1

## What to build

在联调环境里写 e2e，对着真后端跑通再提交。种子数据见后端仓库 scripts/seed.ts。
所有 e2e 共用同一份种子数据、按任意顺序运行：会改状态的测试先通过 /api 新建自己的订单再操作，不要改动别的测试依赖的种子订单。

## Acceptance criteria

- [ ] e2e：打开种子客户乙的订单（待支付），点「支付」后状态显示已支付，状态记录多一项
- [ ] e2e：打开种子客户甲的订单（已支付），填原因「客户要求」取消，状态记录的取消项显示这个原因
- [ ] e2e：已取消的订单不显示任何操作按钮
- [ ] 已有的 e2e 不减少、不跳过
