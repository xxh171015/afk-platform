# M1 技术栈

2026-10-28 · 由决策票「M1 技术栈」定下，是 M1 实现 spec 的输入。设计背景见 [design.md](design.md)，术语见 [GLOSSARY.md](../GLOSSARY.md)。

## 选型一览

| 项         | 选择                                                                                                                                              | 理由                                                                                                                                                                                                |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 运行时     | Node ≥ 22.18，原生直接跑 `.ts`（`api`、`worker`、`cli` 不需要构建步骤），`tsc --noEmit` 只做类型检查                                              | M0 已经这样用；少一个构建步骤。代价：不能用 `enum`、`namespace` 这类要转译的写法，相对导入带 `.ts` 后缀                                                                                             |
| 包管理     | pnpm workspace（`workspace:*`、`pnpm -r`），不用 Turborepo / Nx                                                                                   | 五六个包，用不上缓存和任务编排                                                                                                                                                                      |
| API        | Hono + `@hono/zod-openapi`，Node 适配器 `@hono/node-server`                                                                                       | 路由里用 zod 4 写校验同时生成 OpenAPI；和 M0 已有的 zod 一致；轻量                                                                                                                                  |
| 客户端     | `openapi-typescript` 生成类型 + `openapi-fetch`，放进 `shared` 导出，CLI 和页面共用                                                               | 一份接口描述，一份客户端                                                                                                                                                                            |
| 数据库     | Postgres + Drizzle（`drizzle-orm`、`drizzle-kit`）+ `pg` 驱动                                                                                     | 表结构写在 TS 里，迁移自动生成；队列里的手写 SQL 用 `sql` 模板                                                                                                                                      |
| 作业队列   | 在 Postgres 表上自己实现，放在 `api` 的一个模块里；pg-boss 作为备选                                                                               | 调研：自己实现完全满足设计的语义（约 400 行代码 + 300 行测试）；pg-boss 缺按能力过滤；graphile-worker 锁不能续期。集成分支锁也由这套队列提供（作业上的 `lock_key`，领取时互斥），所以更适合自己实现 |
| 页面       | React 19 + Vite + TanStack Router（文件路由）+ TanStack Query + `@xyflow/react` + Tailwind 4 + 按 import 的 shadcn new-york；openapi-fetch 客户端 | M1 四个视图时用纯 CSS、不引组件库。操作体验改为控制塔（工作台、五个嵌套页、独立 Run），见 [experience-platform.md](specs/experience-platform.md)。不引入 TanStack Start。                                                                 |
| CLI        | `commander`，默认给人看的输出，`--json` 给 skills 和脚本                                                                                          |                                                                                                                                                                                                     |
| 测试       | vitest；lint 和格式化用 Biome                                                                                                                     | 一个工具管 lint + 格式化                                                                                                                                                                            |
| 测试数据库 | 用真 Postgres，不 mock；沙箱镜像里装 PostgreSQL，门禁的 `setup` 在一次性目录里起临时实例；本机开发用同一个脚本或 docker compose，都通过连接串指向 | 沙箱里没有 Docker，而 M1 的票以后可能由 AFK 流水线在沙箱里实现；租约和 `SKIP LOCKED` 的并发语义必须用真库测。不用 PGlite：单连接，测不了并发                                                        |
| 日志       | pino（JSON）                                                                                                                                      |                                                                                                                                                                                                     |

固定的版本在 M1 第一周的脚手架里用锁文件确定；Sandcastle `0.12.0`、Cursor CLI（`.sandcastle/Dockerfile` 的 `CURSOR_CLI_VERSION`）、skills（`SKILLS_SHA`）仍锁精确版本（见 design.md）。

## 仓库布局

```
afk-platform/
├── packages/
│   ├── shared/     类型、zod schema、状态机、生成的 API 客户端
│   ├── api/        Hono 服务 + 调度器 + 作业队列 + Drizzle 表结构与迁移
│   ├── pipeline/   M0 原型里的阶段函数；唯一调用 Sandcastle 的模块
│   ├── worker/     租约循环：向 API 领作业，调用 pipeline，回传结果
│   ├── cli/        plat
│   └── web/        页面
├── docs/
└── compose.yaml    只放 Postgres
```

## 包之间的依赖方向

```
shared  ←  api
shared  ←  pipeline  ←  worker
shared  ←  cli
shared  ←  web
```

- `worker` 不引用 `api`，也不连数据库，只通过 HTTP（`shared` 里的客户端）和 API 说话，哪怕在本机 PoC 里也是。这样 M3 搬到服务器时 worker 不用改。
- 靠 pnpm 的严格依赖保证（`package.json` 里没声明就引用不了），不另配规则工具。
- API 因此需要给 worker 开一组专用接口：领取作业、心跳、回传结果、取渲染上下文所需的数据。
- 阶段函数放在 `pipeline` 里，可以脱离租约循环单独测试；以后换 agent 或 fork Sandcastle，只动 `pipeline`。

## 迁移与种子数据

- `drizzle-kit generate` 生成的 SQL 迁移文件提交进仓库。
- 显式命令 `pnpm db:migrate` 执行迁移；**API 启动时不自动迁移**，发现有未执行的迁移就拒绝启动并提示。
- 不做 SQL 种子。演示数据通过 `plat project create`、`plat spec create` 等真实命令导入，顺带测 CLI。

## 本地怎么起

- `docker compose` 只放 Postgres（开发和测试共用一个镜像）。
- `api` 和 `web` 用 `pnpm dev` 在宿主机上带热更新跑。
- `worker` 永远是宿主机进程（要用 Docker 起沙箱、读 `~/.afk/`）。
- 设计部署表里写的“API + 页面 + Postgres 用 compose 一起起”留给 PoC 稳定后，通过 compose 的 `full` profile 提供，M1 不做。

## 已考虑、没选的

- Fastify + `fastify-type-provider-zod`：生态更重，目前用不上它的插件。
- Kysely：只有查询构建，迁移要另配。
- pg-boss ≥ 12.35：基本满足设计语义，缺按能力过滤；作为自己实现的备选。
- graphile-worker：锁固定 4 小时、不能续期，完成时不校验 attempt，worker 必须直连数据库。
- PGlite：单连接，测不了并发。
- Turborepo / Nx：包太少。
