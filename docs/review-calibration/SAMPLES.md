# 审查校准样本说明

`docs/optimization-plan.md` 8.5 用的样本：从已合并的需求里取 5 份改动，每份人工埋 2 条缺陷（一条违反需求或票，一条违反仓库规范），共 10 条。用来测审查能不能抓到问题，以及换模型后命中有没有变化。

S-60 另加两条本仓库历史提交上的 Ruling 样本（11.3）：一条用别的做法顶替 spec 并带 `/refs/` 原做法，一条只缺外部地址。改 Spec 轴提示词前后各跑一次，看有没有用、有没有改过头。

## 样本

| 样本 | 来源 | 种类 |
| --- | --- | --- |
| `s14-backend-batch-ship` | S-14 后端 PR 整体 | final |
| `s15-backend-note-search` | S-15 后端 PR 整体 | final |
| `s15-frontend-note-search` | S-15 前端，T-25 | ticket |
| `s23-push-retry` | S-23，T-38 | ticket |
| `s28-sandbox-oom` | S-28，T-57 | ticket |
| `s60-substituted-approach` | 本仓库历史提交，顶替 `/refs/host-lib/` | ticket |
| `s60-missing-address` | 本仓库历史提交，只缺外部地址 | ticket |

S-18 在公司 GitLab 上，地址不进仓库，换成了 S-15 后端。

## 格式

`samples/<名字>/` 下：

- `sample.yaml`：`repo` 仓库地址、`base` 基准提交、`kind` 为 `ticket`（票级审查）或 `final`（需求级审查）
- `change.patch`：基准提交之上的改动，已埋好缺陷，`git apply` 即可
- `spec.md`：需求正文
- `ticket.md`：票正文，只有 `ticket` 种类有
- `decisions.json`：可选，写成 `/context/decisions.json`
- `refs/<名字>/`：可选，挂成 `/refs/<名字>/`

`answers.yaml`：每条缺陷的样本、编号、类型（`user-story`、`standards` 或 `type: ruling`）、以及打分用的字段。`user-story` / `standards` 写文件和应用 patch 后的行号范围；`type: ruling` 写 Decision 的 `id` 和 `expect: must-fix` 或 `not: accepted` / `not: must-fix`。只在打分时读，不能进审查 agent 的上下文。

S-60 两条：`s60-substituted-approach` 的 implement 用路径切分顶替了 spec 写明的 `/refs/host-lib/origin-host.ts` 并记 `known-gap`，答案 `expect: must-fix`；`s60-missing-address` 只缺项目飞书 webhook 这个外部地址，答案 `not: must-fix`。

## 打分

一条缺陷算「命中」：审查的某条发现指向同一个文件，行号落在范围内（或描述说的是同一件事），分为 `must-fix` 和 `suggestion` 两档；都没有就是「未发现」。`type: ruling` 按 Spec 轴交回的 `rulings`：交回期望的结论（或不是 `not:` 禁止的那条）记 **命中**，交回不接受的结论记 **未发现**。表按缺陷 × 轴 × 模型列，附每次的 token 用量。运行脚本见 S-35 的 T-86（`scripts/review-calibration.ts`）。
