# 审查校准样本说明

`docs/optimization-plan.md` 8.5 用的样本：从已合并的需求里取 5 份改动，每份人工埋 2 条缺陷（一条违反需求或票，一条违反仓库规范），共 10 条。用来测审查能不能抓到问题，以及换模型后命中有没有变化。

## 样本

| 样本 | 来源 | 种类 |
| --- | --- | --- |
| `s14-backend-batch-ship` | S-14 后端 PR 整体 | final |
| `s15-backend-note-search` | S-15 后端 PR 整体 | final |
| `s15-frontend-note-search` | S-15 前端，T-25 | ticket |
| `s23-push-retry` | S-23，T-38 | ticket |
| `s28-sandbox-oom` | S-28，T-57 | ticket |

S-18 在公司 GitLab 上，地址不进仓库，换成了 S-15 后端。

## 格式

`samples/<名字>/` 下：

- `sample.yaml`：`repo` 仓库地址、`base` 基准提交、`kind` 为 `ticket`（票级审查）或 `final`（需求级审查）
- `change.patch`：基准提交之上的改动，已埋好缺陷，`git apply` 即可
- `spec.md`：需求正文
- `ticket.md`：票正文，只有 `ticket` 种类有

`answers.yaml`：每条缺陷的样本、编号、类型（`user-story` 或 `standards`）、文件、应用 patch 后的行号范围和描述。只在打分时读，不能进审查 agent 的上下文。

## 打分

一条缺陷算「命中」：审查的某条发现指向同一个文件，行号落在范围内（或描述说的是同一件事），分为 `must-fix` 和 `suggestion` 两档；都没有就是「未发现」。表按缺陷 × 轴 × 模型列，附每次的 token 用量。运行脚本见 S-35 的 T-86（`scripts/review-calibration.ts`）。
