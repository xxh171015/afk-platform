# 需求收尾时按 Standards 建议做一次整理，失败就丢掉，不叫人

matt 的 tdd 写明重构不在红 → 绿循环里，而是属于 review 阶段；手动使用 skill 时，人看完 code-review 会让 agent 顺手整理。平台原先（[ADR 0002](0002-afk-runs-execute-matt-skills-under-an-overlay.md)）把坏味道只记成建议、写进验收包，AFK 运行里不做重构。结果 S-35、S-38 的 15 条 Standards 建议一条都没有被处理。现在定为：需求收尾时，如果 final-review 的 Standards 轴给了建议，在 final-fix 合并之后（或 final-review 直接 pass 之后）跑一次 Tidy，只做不改变行为的整理。Tidy 不改已有测试和配置，改完照常过门禁再合并；任何一步失败（agent 失败、门禁不过、冲突、命中 Recheck 的触发条件）都丢掉这次整理，照原样收尾，不叫人，也不占 fix 额度。被处理的建议的处理结果记为 `refactored`。项目设置可以关掉，默认开启。

## Considered Options

- **票级每张都整理**：最接近手动一次 implement 后跟一次 code-review 的节奏，但票级默认只跑 Spec 轴（7.2），要先把 Standards 轴加回票级，每张票多约 4–6 分钟。收尾时 Standards 轴看的是整份改动，跨票的重复也看得见，只整理一次就够。
- **整理也走 Recheck，不过就叫人**：和 review-fix 一样严格，但整理本来就不该碰测试，碰了就说明超出了「不改变行为」，直接丢掉比叫人更合适。
- **保持只记不改**：人在验收时很少逐条看建议，手动使用 skill 时有的效果在平台上就没有了。

## Consequences

- ADR 0002 里「AFK 运行里不做重构」那一句改为以这里为准；票级的 review-fix 和 final-fix 仍然只做红 → 绿、不重构，整理只发生在 Tidy 里。
- Tidy 合并后分支变了：有联调票的需求在开 PR 前同样要跑最终 e2e，和 final-fix 一样。
- 一个需求的每个仓库最多 Tidy 一次；人对收尾的 retry 不会重跑已经丢掉的整理。
