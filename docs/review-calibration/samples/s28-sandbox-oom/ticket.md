# OOM 立刻记为 sandbox-oom

## Parent

S-28

## What to build

容器被内核因内存杀掉时，票、收尾、开 PR 前的 e2e 立刻以原因码 `sandbox-oom` 停下，失败来源是平台，并提示调大内存。不要先拿同一上限把作业失败凑满三次。Locate 的同一码在定位那张票里接上。

原因码会碰到库表，与并行的事件 / Link 迁移各写各的。

## Acceptance criteria

- [ ] inspect 或 exec 见到 OOMKilled 时，票的 blocked 原因是 `sandbox-oom`，失败来源是平台
- [ ] 同一原因码用于收尾或最终 e2e 卡住，且不必先失败三次作业
- [ ] 页面或待处理文案提示调大沙箱内存
- [ ] 原因码表与库约束、失败来源 SQL 函数一起更新，两边测到一致

