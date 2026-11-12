仓库结构、怎么跑门禁、编码规范、保护路径：看根目录 **`AGENTS.md`**。它也是平台 worker 在沙箱里读的那一份，只放两边都成立的内容；只对本机成立的写在这里。

## 本机用哪份 skill

用 `.claude/skills/` 里的 Matt 原版（软链到 `.agents/skills/`，按 `skills-lock.json` 装的）。`packages/pipeline/skills/` 是 worker 挂进沙箱的副本，根目录 `skills/` 是装到各团队规划机器上的副本：本机开发不读它们，也不手改（见各自的 `VENDORED.md`）。

## 本机平台栈（checkout / 重启 / 镜像）

没有「平台向 worker 推文件」的通道。跑 worker 的机器上 `git pull` 到含改动的 commit，改 `packages/pipeline/skills` 或 pipeline 后 **重启 worker**（`scripts/up.sh`），改 API 后重启 api，改 `.sandcastle/Dockerfile` 后重建 `sandcastle:afk-platform` 再重启 worker。业务仓代码走 Git 远端，不靠本机未提交改动。细节见 `docs/operations-manual.md` §1 与 §9。

## 在这个仓库里规划（grill / to-spec / to-tickets）

`skills/` 里的规划 skill 是 Matt 原文的复制，会装到每个团队的规划机器上，只对这个仓库成立的规划规则写在这里，不写进那些副本。

- 推荐答案里说到平台现在怎么做（票的阶段、需求收尾、什么只跑一次、什么会重试）时，先读源码再推荐：从 `AGENTS.md` 的目录说明出发，读 `stage-flow.ts`、`finalize-flow.ts` 这类它点名的文件。没读过就不要当事实说，把问题留到下一轮去查。
- 同一个行为在**票的流水线**和**需求收尾**（联调、最终 e2e 之类）两条路上都要成立时，验收标准里把两条路都写出来，审查才能发现只修了一边的改动。

## Agent skills

### Issue tracker

Issues and specs live as GitHub issues in this repo. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical triage roles with matching label strings on GitHub. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
