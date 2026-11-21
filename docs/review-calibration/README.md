# 审查校准

对真样本跑和线上同一段审查（pipeline 的 `runReview`），打分时才读 `answers.yaml`，输出缺陷 × 轴 × 模型的命中表和 token 用量。

要 Docker、沙箱镜像（默认 `sandcastle:afk-platform`）和 Cursor 密钥。

- 真样本放在 `docs/review-calibration/samples/`，人工答案在同目录上一级的 `answers.yaml`。
- 测试夹具在 `packages/pipeline/src/testing/review-calibration/`（`samples/tiny/` 和它的 4 条答案，含一条 `type: ruling`）。校准脚本只读真样本目录，不会跑夹具。

## 运行

在仓库根目录：

```sh
# ~/.afk/env 或环境里要有 CURSOR_API_KEY 和 AFK_MODEL
# 镜像：AFK_SANDBOX_IMAGE，默认 sandcastle:afk-platform
node scripts/review-calibration.ts
node scripts/review-calibration.ts --spec-model cursor-grok-4.6-xhigh --standards-model cursor-gpt-5
node scripts/review-calibration.ts --dir docs/review-calibration
```

表打到 stdout。审查 agent 看不到答案文件。某个样本克隆或审查失败时，表里这一行标失败，其余样本照常打分。

## 样本

每个真样本一个目录 `docs/review-calibration/samples/<名字>/`：

- `sample.yaml`
  - `repo`：仓库地址（git clone 能用的 URL 或本地路径）
  - `base`：基准提交 SHA
  - `kind`：`ticket`（两轴 review）或 `final`（final-review）
- `change.patch`：相对 `base` 的 unified diff（`git diff`），脚本只取该提交、不留远端引用，然后 apply 并提交
- `spec.md`：需求正文，写成审查 agent 在 `/context/spec.md` 里读到的那样
- `ticket.md`：可选。`kind: ticket` 时写成 `/context/ticket.md`；`kind: final` 可以没有
- `decisions.json`：可选。写成审查沙箱里的 `/context/decisions.json`（决策日志）
- `refs/<名字>/`：可选。每个子目录挂成审查沙箱里的 `/refs/<名字>/`

测试夹具 `tiny` 的起始树在 `packages/pipeline/src/testing/review-calibration/samples/tiny/`：`AGENTS.md`（一句 `Do not skip tests.`）和 `src/app.ts`：

```ts
export function greet(name: string): string {
  return "hello " + name;
}

export function add(a: number, b: number): number {
  return a + b;
}
```

## 答案

真跑的 `docs/review-calibration/answers.yaml` 在真样本目录外面，审查全部跑完才读。测试夹具的答案在 `packages/pipeline/src/testing/review-calibration/answers.yaml`。每条：

```yaml
- sample: tiny          # samples/<名字>
  id: us-1              # 表里的编号
  type: user-story      # 或 standards
  file: src/app.ts
  lines: "6-7"          # 含两端；单行写成 "10-10"
  description: skipped the negative check the story asked for
- sample: tiny
  id: ru-1
  type: ruling          # 按审查交回的 rulings 打分
  decision: R-1#0       # Decision 的 id
  expect: must-fix      # 或 not: accepted / not: must-fix
  description: known-gap skipped rejectNegatives from /refs/arith
```

`type: user-story` / `standards` 按文件和行范围对齐发现：must-fix 命中、suggestion 命中（建议文本以 `file:line` 开头）、否则 未发现。`type: ruling` 看 Spec 轴交回的 `rulings`：`expect:` 命中该结论、或 `not:` 交回的不是那个结论时记 **命中**，否则 **未发现**。同一条缺陷两个轴、每个模型各记一格。

S-60 两条真样本：`s60-substituted-approach`（顶替 `/refs/host-lib/` 的做法，`expect: must-fix`）、`s60-missing-address`（只缺外部地址，`not: must-fix`）。说明见 `SAMPLES.md`。
