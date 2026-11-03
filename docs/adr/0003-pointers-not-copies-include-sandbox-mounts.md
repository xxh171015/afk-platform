# 存指针、不复制：沙箱挂载不是第二份正文

设计原则第 4 条仍是「原文只在仓库里，平台只存指针，prompt 只放路径」。agent 读到的 `/context/contract/` 和 `/context/domain/` 是该指针在沙箱里按 SHA 的只读挂载，不是平台库里的第二份正文，也不是把全文写进 prompt。规划阶段的术语和 ADR 作为规划提交成为规划仓库集成分支的起点，不先推 main。

> 规划提交由谁做、怎么做已被 [ADR 0005](0005-planning-docs-go-with-the-spec-committed-by-the-platform.md) 取代：由平台提交，人不提交、不推送。本 ADR 的「存指针、不复制」不变。

## Considered Options

- **坚持「agent 只读工作区里的文件」，跨仓库靠手写 `refs:`**：规划仓库的 GLOSSARY / ADR 到不了前端票，除非每张票都记得挂参考仓。
- **把 GLOSSARY / ADR 正文存进平台库再注入 prompt**：平台变成文档副本，和「存指针」相反，也和契约已经走挂载的路分叉。
- **把规划仓库整仓挂进 `/refs`**：前端 agent 会看到一份不该改的后端工作区。

## Consequences

- 原则第 4 条的表述要改（终局 spec 改 `docs/design.md`），精神不变。
- 不是规划仓库的票才挂 `/context/domain/`；规划仓库的票工作区已经在规划提交上。
- ~~`plat spec confirm` 在规划仓库里登记规划提交 SHA；页面确认不读本地 git。~~ 见 ADR 0005。
