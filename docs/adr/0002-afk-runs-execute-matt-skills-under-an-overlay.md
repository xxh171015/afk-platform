# AFK 运行在覆盖层下原样跑 matt 的 skill，code-review 的两轴由平台拆成两次运行

执行阶段不再把步骤自己写进 prompt，而是让 agent 照固定 skills SHA 上的 matt skill 原文做：implement 阶段按路径读 `implement` skill（它是 `disable-model-invocation: true`，模型不会自己调用）；review 和 final-review 跑 `code-review`；各种修复和 rework 读 `tdd`。无人值守需要的东西放在平台的**覆盖层**里，叠在 skill 之上：不许提问，`/context` 就是 tracker，不 push，保护路径规则，`<result>` 输出格式；skill 里每个"去问用户"的地方逐条写死成平台给的答案。implement 里最后调用 code-review 的那一步由覆盖层跳过，因为平台另有 review 阶段。

`code-review` 要求 Standards 和 Spec 两轴用并行子 agent 互相隔离。平台不让 agent 自己开子 agent，而是在 review 阶段里并行跑两次 agent 运行，每次运行扮演一轴的子 agent，最后由 worker 用代码按 skill 第 5 步拼结果，不合并也不重排。两次运行算同一个阶段，任一轴失败就两轴一起重跑。

## Considered Options

- **照 skill 原样跑，让 agent 自己开两个子 agent**：最贴近原文，但 Cursor CLI 是否提供 Task 工具由服务端按账号和团队策略决定，我们的沙箱没有实测过；子 agent 运行时父 agent 不输出，可能触发 idle timeout；两轴的过程也会混在一条 Run 里。实测稳定后可以作为可选项。
- **一个 agent 先做完一轴再做另一轴**：不依赖 Task 工具，但两轴会互相影响上下文，这正是 skill 要避免的。
- **继续用平台自己写的 prompt，不跑 matt 的 skill**：平台和 GitHub 两条路的执行行为就会分叉，matt 改进 skill 时平台也跟不上。
- **fork skill**：要长期维护一份分叉；覆盖层已经能表达所有冲突（见冲突清单），没必要 fork。

## Consequences

- 覆盖层引用了 skill 里的具体步骤（比如 code-review 第 1–3 步、第 4 步的 brief），所以绑定到 skills SHA：覆盖层写明它对应的 SHA，和平台固定的 SHA 不一致时有测试失败，升级 skills 时必须回头核对覆盖层。
- review 结果的每一项带审查轴（`axis`），要改平台的 schema。坏味道和 scope creep 只进 suggestions，写进验收包由人看；AFK 运行里不做重构。
- 现在 code-review 的第 3 步（找标准来源）由覆盖层替 agent 做完，Standards 轴只认 `AGENTS.md`、覆盖层规范和坏味道基线。优化计划 4.2 落地后改为 agent 按 skill 原文自己找，`AGENTS.md` 和覆盖层写明的规范仍一定在列，用到的文件记在 Run 的 `sources` 上；两次运行互相隔离、不开子 agent 的取舍不变。
- 联调 implement 和诊断阶段不跑 matt 的 skill，只接覆盖层：e2e 是对着已经实现好的服务写的，套不上 tdd 的红 → 绿。
