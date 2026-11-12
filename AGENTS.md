# AGENTS.md

给在这个仓库里工作的 agent 看：平台 worker 在沙箱里跑的 agent 和本机开发的 agent 读的都是这一份，所以这里只写两边都成立的内容。只对 AFK 运行成立的规则在平台覆盖层（`packages/pipeline/prompts/overlay.md`），只对本机成立的在 `CLAUDE.md`。

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
pnpm test packages/api/src/xxx.test.ts   # 只跑一个测试文件
pnpm lint                            # biome check .
```

提交前这三条都要通过。门禁跑的就是它们，配置在 `.sandcastle/gates.yaml`。改了 `packages/api/src/db/schema.ts` 要 `pnpm --filter @afk/api db:generate` 并把生成的 SQL 一起提交。改了 API 路由要 `pnpm gen:api` 更新 OpenAPI 和生成的类型。

## 编码规范

- TypeScript strict。相对导入带 `.ts` / `.tsx` 后缀。不用 `enum`、`namespace`。
- 新行为先写测试（红 → 绿）。测试走公共接口（HTTP、CLI、导出的纯函数），不测私有方法和内部调用次数。
- API 层测试用真 Postgres；不要为了测试去 mock 自己的模块。系统边界（GitHub/GitLab HTTP、agent 运行器、时间）才允许假对象。
- 不要删除或跳过已有测试（`it.skip`、`it.only`、`describe.skip` 都不行）。门禁会比较测试总数和跳过数，变少就判失败。
- 术语以 `GLOSSARY.md` 为准。不要引入它明确 Avoid 的叫法。
- commit 信息用英文祈使句，一个 commit 做一件事。

## 保护路径

下面这些路径不要改。确实需要改时，交给人决定：

- `.sandcastle/**`
- `.github/**`
- `packages/shared/src/skills-sha.ts`
- `packages/pipeline/package.json`（Sandcastle 版本）
- `biome.json`、`pnpm-workspace.yaml`、根 `package.json` 的 `scripts`
