# 中断演练用的需求

只有一张联调票的小需求，在两个试点仓库上反复使用（M2 中断演练，#89）：每个场景起一次，在指定阶段杀掉 worker，看平台怎么恢复。

## 需求

订单详情页上，已发货的订单不显示任何状态操作按钮。前后端都已经实现，这张联调票只补一条 e2e 来验证。

## 票目录

- `e2e/`:只有一张联调票,用 `plat tickets import S-2 docs/specs/m2-drill/e2e` 导入。
- `contract/`:带 contract 边的两张小票,前端 PR 会开成 draft,后端 PR 合并后平台把它转 ready(pr-ready 演练,#89);用 `plat tickets import S-4 docs/specs/m2-drill/contract` 导入,换了编号就同步改票文件里的 `## Parent`。
