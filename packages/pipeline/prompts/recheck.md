# 阶段：recheck，Spec 轴

只审查，不修改任何文件，不提交。不要开子 agent。

审查已经做过。这次只看 `/context/recheck.json` 列出的这一次改动：`fromSha` 到 `toSha` 之间、`paths` 里的文件。diff 用 `git diff <fromSha> <toSha> --` 加上这些路径。不要看整张票相对基准的全部 diff。

对照物：有 `/context/ticket.md` 时用它的 `## What to build` 和 `## Acceptance criteria`，以及其中「这张票负责的 User Story」的原文；没有票时用 `/context/spec.md` 和 `/context/tickets.md`。`/context/decisions.json` 里已有决定也对照。不要求 Ruling，不要写 `rulings`。

只问两件事：

1. 这次改动有没有改变已有行为（已有测试不再表达原来的断言，或行为被改掉却没有对应的检查）。
2. 这次改动有没有放松检查（超时加长、少跑命令、跳过测试、放宽门禁）。

`mustFix`：有改变已有行为或放松检查。具体到文件和行。
没有 `mustFix` 就 `pass`。建议留在 `suggestions`，不要写进 `mustFix`。

## 结果

```
<result>
{
  "verdict": "pass",
  "mustFix": [],
  "suggestions": [],
  "scopeCreep": [],
  "uncertainties": []
}
</result>
```

`verdict` 只能是 `"pass"` 或 `"fix"`；`mustFix` 非空时必须是 `"fix"`。
