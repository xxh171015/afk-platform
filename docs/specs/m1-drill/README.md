# 中断演练用的票

每个子目录是一个 spec 要导入的票目录(一张票一个 `.md` 文件),用 `plat tickets import <编号> <目录>` 导入;编号是 `spec create` 打印出来的那个,文件里 `## Parent` 写的编号要和它一致。

| 目录 | 用于 | 内容 |
| --- | --- | --- |
| `serial/` | 中断演练(#42) | 三张串行的小票,每张只加一个文档文件,足够让一次运行有 implement、gate、review、merge 各阶段 |
| `single/` | 中断演练 3、4 | 一张小票 |
| `parallel/` | 中断演练 5 | 两张互不依赖的小票,同一仓库,会同时排上 merge 作业 |
