# 第三轮复查：缺陷与配置修复

## Problem Statement

第三轮复查（`docs/optimization-plan.md` 第 4 节）在真实运行记录和代码里找到一批小而确定的缺陷和配置障碍：

- 会改代码的阶段提示词写死了 npm 命令，非 Node 仓库的 agent 会去跑一条不存在的命令。
- 收尾里 final-fix 修完的必须修仍显示 `unhandled`，验收包和 PR 描述会让人以为有问题漏了。
- agent 做完后 push 只试一次，网络抖一下就白跑一轮 agent（T-32 两次各约 30 分钟）。
- 鉴权失败、模型名无效、额度用完、联调镜像构建失败这类不可恢复的错误，也被重排到第三次才叫人。
- `--default-agent` 能填但不起作用。
- 纯 GitLab 团队在 afk-setup 第一步就被要求登录 gh，`scripts/up.sh` 也不认 GitLab 令牌。
- 测试在 Mac 上不是全绿，而平台的 API 和 worker 正是跑在 Mac 上。

## Solution

从使用平台的人看：

- agent 提交前跑的，就是这个仓库门禁实际配置的命令，无论仓库是什么语言。
- 验收包里的必须修如实标成「已交给 fix 处理」。
- push 遇到网络问题会原地等一会儿再试，不重跑 agent。
- 密钥失效这类错误第一次就进待处理队列，简报用一句人话说清楚怎么改。
- 填了不支持的 agent 会被直接拒绝。
- 一台没装 gh 的机器能为 GitLab 项目走完 afk-setup；`up.sh` 认 GitLab 令牌并给出修复命令。
- Mac 上 `pnpm check` 全绿。

## User Stories

1. 作为接入 Java 仓库的团队负责人，我希望 agent 提交前跑的是我 `gates.yaml` 里写的命令，这样它不会去跑一条不存在的 `npm test`。
2. 作为 Go 仓库的开发者，我希望提示词里不出现具体的构建或测试命令，这样提示词不会替我的仓库做错误假设。
3. 作为平台维护者，我希望有一条测试扫描所有阶段提示词，发现写死的构建或测试命令就失败，这样以后不会再有人写回去。
4. 作为 agent，我希望从 `/context/run.json` 读到带名字的门禁命令，`setup` 单列，这样我知道提交前要跑哪些、环境怎么装。
5. 作为验收人，我希望 PR 描述里的必须修在 final-fix 完成后不再写「未处理」，这样我不会以为有问题漏了。
6. 作为验收人，我希望这些意见的措辞是「已交给 fix 处理」而不是「已修复」，这样我知道它只表示 fix 阶段完成且门禁通过，没有复审。
7. 作为看度量的人，我希望已有数据里 final-fix 完成过的需求，其必须修也被纠正，这样按 Finding 算的数字不偏。
8. 作为在网络不稳的环境里用平台的人，我希望 agent 做完后 push 遇到连不上、超时、5xx 时原地退避重试（10、30、90、180 秒），这样一次抖动不会白跑约一小时的 agent。
9. 作为平台维护者，我希望 push 被拒（non-fast-forward、保护分支、无权限）时不重试，这样真正的错误不会被拖延。
10. 作为平台维护者，我希望每次 push 重试前再做一次租约检查，这样丢了租约的 worker 不会继续推送。
11. 作为规划者，我希望 Cursor 鉴权失败第一次就让作业失败进待处理队列，这样不会空转三次。
12. 作为规划者，我希望简报里有一句「Cursor 密钥失效或没有权限，更新 `~/.afk/env` 里的 `CURSOR_API_KEY` 后重试」，失败来源记为外部服务，这样我知道怎么办。
13. 作为规划者，我希望模型名无效、额度用完、联调镜像构建失败也按不可恢复处理，这样不会白白重试。
14. 作为登记项目的人，我希望 `plat project create/edit --default-agent claude-code` 被拒并说明目前只支持 Cursor，这样我不会以为它生效了。
15. 作为已有项目填了别的值的人，我希望 `plat project show` 把它标成「当前不生效」而不是改我的数据，这样迁移留到 agent 提供方配置化时统一做。
16. 作为只用 GitLab 的团队，我希望没装 gh 的机器也能对 GitLab 项目跑完 `/afk-setup`，这样接入不会在第一步被拦住。
17. 作为 afk-setup 的使用者，我希望只有项目里有 GitHub 仓库时才要求 gh 登录，也不再建 GitHub 标签，这样 GitLab 项目没有多余步骤。
18. 作为第一次启动平台的 GitLab 用户，我希望 `scripts/up.sh` 认 `~/.afk/secrets/gitlab/<host>` 的令牌，逐个检查权限并调用 GitLab 验证，显示用户名和到期日，这样我看不到无关的 GitHub App 警告。
19. 作为令牌文件权限是 644 的用户，我希望看到 `chmod 600` 的命令，这样不用等到 worker 第一次跑托管作业才发现。
20. 作为一种凭据都没有的新用户，我希望在终端里被问用 GitHub 还是 GitLab，并被引导完成配置。
21. 作为用脚本或 launchd 调用 `up.sh` 的人，我希望非终端环境下它不提问，直接失败并打印两种配置方式的命令，`--check` 永远不提问，这样自动化不会卡住。
22. 作为在 Mac 上开发平台的人，我希望 `pnpm check` 在 Mac 上全绿，这样我能在平台真实运行的机器上快速验证。
23. 作为在小磁盘沙箱里跑测试的人，我希望测试不读宿主机的磁盘余量，这样磁盘低于 5 GiB 时结果不变。
24. 作为维护者，我希望门禁和 e2e 的假沙箱用 Node 计时、超时杀进程，不依赖宿主机的 `timeout` 命令，这样 Mac 上不再因为没有 GNU `timeout` 而失败。

## Implementation Decisions

- 提示词和上下文：worker 渲染 `/context/run.json` 时，把这个仓库这次生效的门禁命令（带名字，`setup` 单列）写进 `gate`。会改代码的阶段提示词（包括 implement、integration-implement、gate-fix、review-fix、merge-fix、final-fix、update-branch 和联调相关的提示词，共 8 个文件）统一改成「提交前按 `/context/run.json` 的 `gate` 逐条跑通」。`setup` 只列出来，不要求 agent 自己再跑。matt 的 implement 原文要求「经常跑类型检查和单个测试文件，最后跑一次全量」：覆盖层补一句，单个测试文件怎么跑看仓库的 `AGENTS.md`；afk-setup 写 `AGENTS.md` 时把这一条写进去。
- 防回退：提示词目录里不得出现具体的构建或测试命令（npm、pnpm、make、mvn、go test 等黑名单）；对 `AGENTS.md` 的引用不算违规。
- Finding：final-fix 结果为 done 时，把同一需求、同一仓库、这次收尾的 final-review 里仍为 `unhandled` 的必须修标为 `fixed`；补一条迁移纠正已有数据。`fixed` 的口径和票级 review-fix 一致（fix 阶段报 done 且门禁通过，不表示已验证修好）。验收包和 PR 描述里的措辞改成「已交给 fix 处理」。收尾仍只跑一次 final-review，不加复审。`GLOSSARY.md` 的 Finding 条目已写明这个口径。
- push 重试：agent 做完后的 push 遇到网络类错误（连不上、超时、5xx）原地退避重试，等 10、30、90、180 秒；每次重试前再做一次 pre-push 租约检查；被拒不重试。「重派时跳过 agent 直接 push」不在本 Spec 里。
- 不可恢复错误：worker 把确定不是偶发的错误（Cursor 鉴权失败、模型名无效、额度用完、联调镜像构建失败）单独归类；这类错误让作业第一次就失败、不再重排，失败来源记为外部服务，简报给出一句人话的原因和修复提示。「密钥问题出现后暂停领取」不做，等 worker 身份方案定稿后再评估。
- `default_agent`：登记（create、edit）时拒绝 `cursor` 以外的值并说明目前只支持 Cursor；已有的别的值不改，`plat project show` 等处标「当前不生效」。
- afk-setup：只有项目里有 GitHub 仓库时才把 `gh` 登录作为前提；确认没有 skill 还会用 GitHub 标签后，删掉建标签这一步；排查 afk-setup、tracker doc 模板和 `plat init` 里只适用于 GitHub 的步骤。
- `scripts/up.sh`：托管凭据改成「至少有一种」。有 GitLab 令牌文件就逐个检查权限，并调用 GitLab 的用户接口验证，显示用户名和到期日（复用已有的令牌自检）。一种都没有时，只在 stdin 是终端时才问用 GitHub 还是 GitLab，选 GitLab 就问主机和令牌、写文件、设 600、验证；非终端环境直接失败退出并打印两种方式的命令；`--check` 永远不提问。GitHub App 的提示只在选 GitHub 时出现。
- 测试环境：测试注入磁盘余量，不读宿主机；门禁和 e2e 的假沙箱超时用 Node 计时、杀进程，真沙箱照旧；沙箱清理测试对临时目录先取真实路径；用真 git 和 HTTP 的端到端测试设更长的超时。

## Testing Decisions

- 好的测试只测外部行为：HTTP、CLI、导出的纯函数；不测私有方法和内部调用次数。系统边界（代码托管 HTTP、agent 运行器、时间）才用假对象；API 层测试走真 Postgres，不 mock 自己的模块。
- 使用的 seams（测试缝，都是已有的，不新增，已和用户确认）：
  - API 层 HTTP 测试（真 Postgres）：Finding 的 `fixed` 标记（final-review 给出 fix → final-fix done → 验收包和 PR 描述里标为已交给 fix 处理）、不可恢复错误一次失败就进待处理队列且简报含那句话、`default_agent` 被拒、迁移纠正已有数据。
  - pipeline 导出的纯函数：`run.json` 里的 `gate`（`gates.yaml` 用 `make test` 的仓库，提示词和 `run.json` 里没有 npm）、扫描提示词目录的黑名单测试。
  - worker 层用假远端和假 agent：push 前三次连接失败第四次成功，作业一次完成、agent 只跑一次；被拒的 push 不重试；鉴权错误只失败一次。
  - CLI 与脚本：`plat project` 拒绝 `claude-code`；`up.sh --check` 在只有 GitLab 令牌时全部通过且没有 GitHub 警告；令牌权限 644 时给出 `chmod 600`；非终端时不提问。
  - 4.16 的验收：Mac 上 `pnpm check` 全绿；沙箱磁盘低于 5 GiB 时测试结果不变。
- 先例：现有 `stages-api`、`failures-api`、`lease-api`、`push`、`gate`、`context`、`plat-cli`、`plat-init` 一类测试。

## Out of Scope

- 重派的作业跳过 agent 直接 push（单独成条，之后做）。
- worker 在密钥失效后暂停领取。
- final-fix 之后加复审。
- 页面上的项目设置（4.12）、可开关的整理步骤（4.4）、票级审查的成本（4.15）。
- agent 提供方做成项目配置（2.9）：这里只是在它落地之前先拒绝不支持的值。

## Further Notes

- 来源：`docs/optimization-plan.md` 第 4 节，其中 4.1、4.5、4.6 第 1 步、4.7、4.9、4.10、4.11、4.16 的决定都已在 grill 中确认。
- 术语以 `GLOSSARY.md` 为准；Finding 的 `fixed` 口径已写进那里。本 Spec 的规划文档改动（`GLOSSARY.md`、ADR 0002）随 `plat spec confirm` 一起带给平台。
- 4.2、4.3 的票级审查对齐依赖这里的 `run.json` 里加 `gate`，所以放在后一个 Spec 里。

