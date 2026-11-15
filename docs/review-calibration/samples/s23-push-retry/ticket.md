# push 网络失败原地退避重试


## Parent

S-23

## What to build

agent 做完后 push 遇到网络类错误（连不上、超时、5xx）时，不再让作业失败重派，而是原地退避重试，等 10、30、90、180 秒；每次重试前再做一次 pre-push 租约检查；被拒（non-fast-forward、保护分支、无权限）不重试。重派时跳过 agent 直接 push 不在这张票里。

## Acceptance criteria

- [ ] 假远端前三次连接失败、第四次成功：作业一次完成，agent 只跑一次
- [ ] 被拒的 push（non-fast-forward、保护分支、无权限）不重试，按现有流程失败
- [ ] 每次重试前都做租约检查，租约丢失时不再 push
- [ ] 四次都失败时，作业按现有的基础设施失败处理

