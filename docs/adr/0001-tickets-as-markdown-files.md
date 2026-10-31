# 票以 issue 模板原文的 markdown 文件导入，正文是唯一来源

平台作为 tracker 时，票的内容要和 to-tickets 的 issue 模板一字不差。所以导入格式从单个 `tickets.yaml` 改成一个目录，一张票一个 markdown 文件：front matter 放 title 和平台字段（repo、type、modules、依赖等），之后是正文，也就是模板原文。验收标准不再单独写，导入和改票时从正文的 `## Acceptance criteria` 一节按严格规则解析出来。`/context/ticket.md`、`plat ticket view --md`、`plat ticket edit --file` 用的都是这同一种文件。

## Considered Options

- **保留 `tickets.yaml`，`body` 原样放模板，导入时检查 `acceptance` 和正文一致**：模型要把验收标准写两遍，YAML 的引号和缩进问题也还在。导入时能查出不一致，但查不出模板结构在"翻译"成字段时丢了什么。
- **两种格式都接受**：importer 要维护两套解析，tracker 文档也要讲两种写法，一字不差的保证只在其中一种格式下成立。

## Consequences

- 已经装进规划仓库的 tracker 文档（旧 `tickets.yaml` 格式）必须跟着更新，否则 to-tickets 会写出被拒绝的文件。
- 平台自己建的修复票也按同一个模板拼正文，和人写的票走同一条解析路径。
