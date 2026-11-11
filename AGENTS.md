# AGENTS.md

给在这个仓库里工作的 agent 看。AFK 运行时没有人回答问题：遇到必须由人决定的事，按 prompt 的要求输出 `cannot-proceed` 并结束，不要停下来提问。

## 这个仓库是什么

AFK 研发平台本身：人只在规划和最终合并时出现，中间由平台按依赖图调度 agent 在沙箱里逐张票实现。pnpm workspace，包依赖方向只能是 `shared ← api / pipeline / cli / web`，`pipeline ← worker`。`worker` 不引用 `api`，也不连数据库。

- `packages/shared`：类型、zod schema、状态机、生成的 API 客户端（票阶段 `stage-flow.ts`，收尾 `finalize-flow.ts`）
- `packages/api`：Hono 服务、调度、作业队列、Drizzle 表结构
- `packages/pipeline`：阶段函数，唯一调用 Sandcastle 的模块
- `packages/worker`：租约循环
- `packages/cli`：`plat`
- `packages/web`：控制塔页面
- `GLOSSARY.md`、`docs/adr/`、`docs/design.md`：术语和已定决策，不要另造同义词

## 怎么跑

沙箱里没有 Docker。门禁的 `setup` 会用 `scripts/pg-temp.sh` 起一次性 Postgres。测试连真 Postgres，不 mock 数据库。

```sh
pnpm install --frozen-lockfile
eval "$(scripts/pg-temp.sh start)"   # 导出 DATABASE_URL
pnpm typecheck
pnpm test                            # vitest run，JUnit 写到 reports/junit.xml
pnpm lint                            # biome check .
```

提交前这三条都要通过。门禁跑的就是它们，配置在 `.sandcastle/gates.yaml`。改了 `packages/api/src/db/schema.ts` 要 `pnpm --filter @afk/api db:generate` 并把生成的 SQL 一起提交。改了 API 路由要 `pnpm gen:api` 更新 OpenAPI 和生成的类型。

**本机平台栈（checkout / 重启 / 镜像）：** 没有「平台向 worker 推文件」的通道。跑 worker 的机器上 `git pull` 到含改动的 commit，改 `packages/pipeline/skills` 或 pipeline 后 **重启 worker**（`scripts/up.sh`），改 API 后重启 api，改 `.sandcastle/Dockerfile` 后重建 `sandcastle:afk-platform` 再重启 worker。业务仓代码走 Git 远端，不靠本机未提交改动。细节见 `docs/operations-manual.md` §1 与 §9。

## 在这个仓库里规划（grill / to-spec / to-tickets）

`skills/` 里的规划 skill 是 Matt 原文的复制，会装到每个团队的规划机器上，只对这个仓库成立的规划规则写在这里，不写进那些副本。

- 推荐答案里说到平台现在怎么做（票的阶段、需求收尾、什么只跑一次、什么会重试）时，先读源码再推荐：从上面的目录说明出发，读 `stage-flow.ts`、`finalize-flow.ts` 这类它点名的文件。没读过就不要当事实说，把问题留到下一轮去查。
- 同一个行为在**票的流水线**和**需求收尾**（联调、最终 e2e 之类）两条路上都要成立时，验收标准里把两条路都写出来，审查才能发现只修了一边的改动。

## 编码规范

- TypeScript strict。相对导入带 `.ts` / `.tsx` 后缀。不用 `enum`、`namespace`。
- 新行为先写测试（红 → 绿）。测试走公共接口（HTTP、CLI、导出的纯函数），不测私有方法和内部调用次数。
- API 层测试用真 Postgres；不要为了测试去 mock 自己的模块。系统边界（GitHub/GitLab HTTP、agent 运行器、时间）才允许假对象。
- 不要删除或跳过已有测试（`it.skip`、`it.only`、`describe.skip` 都不行）。门禁会比较测试总数和跳过数，变少就判失败。
- 术语以 `GLOSSARY.md` 为准。不要引入它明确 Avoid 的叫法。
- commit 信息用英文祈使句，一个 commit 做一件事。不要自己加 `Spec:` / `Ticket:` / `Run:` trailer，平台会补。

## 保护路径

下面这些路径不要改。确实需要改时，在结构化输出里说明，由人决定：

- `.sandcastle/**`
- `.github/**`
- `packages/shared/src/skills-sha.ts`
- `packages/pipeline/package.json`（Sandcastle 版本）
- `biome.json`、`pnpm-workspace.yaml`、根 `package.json` 的 `scripts`
