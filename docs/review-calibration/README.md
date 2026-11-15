# 审查校准

对 `samples/` 里埋了缺陷的样本跑和线上同一段审查（pipeline 的 `runReview`），打分时才读 `answers.yaml`，输出缺陷 × 轴 × 模型的命中表和 token 用量。

要 Docker、沙箱镜像（默认 `sandcastle:afk-platform`）和 Cursor 密钥。样本和答案由人另外准备；`samples/tiny/` 只给测试用。

## 运行

在仓库根目录：

```sh
# ~/.afk/env 或环境里要有 CURSOR_API_KEY 和 AFK_MODEL
# 镜像：AFK_SANDBOX_IMAGE，默认 sandcastle:afk-platform
node scripts/review-calibration.ts
node scripts/review-calibration.ts --spec-model cursor-grok-4.6-xhigh --standards-model cursor-gpt-5
node scripts/review-calibration.ts --dir docs/review-calibration
```

表打到 stdout。审查 agent 看不到答案文件。

## 样本

每个样本一个目录 `samples/<名字>/`：

- `sample.yaml`
  - `repo`：仓库地址（git clone 能用的 URL 或本地路径）
  - `base`：基准提交 SHA
  - `kind`：`ticket`（两轴 review）或 `final`（final-review）
- `change.patch`：相对 `base` 的 unified diff（`git diff`），脚本检出 `base` 后 apply 并提交
- `spec.md`：需求正文，写成审查 agent 在 `/context/spec.md` 里读到的那样
- `ticket.md`：可选。`kind: ticket` 时写成 `/context/ticket.md`；`kind: final` 可以没有

`tiny` 的起始树：`AGENTS.md`（一句 `Do not skip tests.`）和 `src/app.ts`：

```ts
export function greet(name: string): string {
  return "hello " + name;
}

export function add(a: number, b: number): number {
  return a + b;
}
```

## 答案

`answers.yaml` 在样本目录外面，审查全部跑完才读。每条：

```yaml
- sample: tiny          # samples/<名字>
  id: us-1              # 表里的编号
  type: user-story      # 或 standards
  file: src/app.ts
  lines: "6-7"          # 含两端；单行写成 "10-10"
  description: skipped the negative check the story asked for
```

打分按文件和行范围对齐发现：must-fix 命中、suggestion 命中（建议文本以 `file:line` 开头）、否则 未发现。同一条缺陷两个轴、每个模型各记一格。
