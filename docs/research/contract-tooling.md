# 契约工具链选型的事实（#63）

查证日期：2026-10-30。版本号、发布日期、许可证、`engines`、依赖数来自 npm registry（`https://registry.npmjs.org/<pkg>`）当天的 `latest`；维护状态来自 GitHub API（`archived`、`pushed_at`）；功能和 OpenAPI 版本支持来自各项目自己的 README / 文档 / 源码。只列事实和取舍，不做决定，选型在 #67 定。标「推断」的是根据事实做的推论，没有实测。

## 先说一个影响所有选项的事实：契约是 OpenAPI **3.1.0**

后端试点 `xxh171015/afk-pilot-backend` 的 `openapi/openapi.yaml` 第一行是 `openapi: 3.1.0`，并且已经用了 3.1 才合法的写法（`/health` 响应里的 `{ const: ok }`）。OpenAPI 3.1 的 Schema Object 就是 JSON Schema 2020-12 的方言；3.0 的 Schema Object 是 JSON Schema 早期草案的改版子集（有 `nullable`，没有 `const`、类型数组等）。所以下面凡是「只支持 OpenAPI 2 / 3.0」的工具，对现在的契约就不完全适用。
来源：契约文件（`gh api repos/xxh171015/afk-pilot-backend/contents/openapi/openapi.yaml`）；[OAS 3.1.0 Schema Object](https://spec.openapis.org/oas/v3.1.0#schema-object)；[OAS 3.0.3 Schema Object](https://spec.openapis.org/oas/v3.0.3#schema-object)。

后端 `package.json`：`engines.node >=22`，devDependencies 精确锁定 `typescript 5.9.3`、`vitest 3.2.7`、`@types/node 22.20.5`，无运行时依赖。

## 总表

| 包 | latest（发布日） | 许可证 | Node `engines` | 直接依赖数 | 仓库状态（最后 push） | OpenAPI 3.1 |
|---|---|---|---|---|---|---|
| `openapi-typescript` | 7.13.0（2026-02-11） | MIT | 未声明（README 建议 20+） | 6 | active（2026-09-25） | 支持 3.0 / 3.1 |
| `openapi-fetch` | 0.17.0（2026-02-11） | MIT | 未声明 | 1 | 同上 | 吃 openapi-typescript 的类型 |
| `orval` | 8.45.0（2026-10-25） | MIT | `>=22.18.0` | 25 | active（2026-10-29） | 支持（内部升级到 3.1 形态） |
| `@hey-api/openapi-ts` | 0.99.0（2026-06-22） | MIT | `>=22.18.0` | 10 | active（2026-09-30） | 「支持所有合法 OpenAPI 版本」 |
| `msw` | 3.0.3（2026-10-10） | MIT | `>=22.12.0` | 12 | active（2026-10-17） | 不涉及（不读契约） |
| `@msw/source`（原 `@mswjs/source`） | 0.7.0（2026-09-28） | 仓库 MIT，npm 包未写 license 字段 | `>=22` | 7 | active（2026-09-30） | 源码同时处理 `OpenAPIV3` 与 `OpenAPIV3_1` |
| `openapi-msw` | 2.1.1（2026-10-27） | MIT | 未声明 | 0 | active（2026-10-27） | 吃 openapi-typescript 的类型 |
| `msw-auto-mock` | 0.32.1（2026-04-18） | npm 写 MIT，仓库未识别出许可证 | 未声明 | 11 | active（2026-04-18） | 依赖 `@apidevtools/swagger-parser 10.1.0`（旧） |
| `@msw/serve`（原 `@mswjs/http-middleware`） | 0.11.0（2026-09-28） | MIT | `>=22` | 1 | active | 不涉及 |
| `@stoplight/prism-cli` | 5.16.0（2026-07-17） | Apache-2.0 | **`>=24.18.0`** | 21 | active（2026-10-22） | README 写支持 3.1 / 3.0 / 2.0 |
| `openapi-backend` | 5.23.0（2026-10-28） | MIT | `>=20.0.0` | 10 | active（2026-10-28） | README 写支持 3.1（见下文细节） |
| `openapi-response-validator` | 12.1.3（2023-05-24） | MIT | 未声明 | 2 | 仓库 active 但最后 push 2024-12-17 | 未声明 3.1 |
| `jest-openapi` / `chai-openapi-response-validator` | 0.14.2（2022-01-03） | MIT | 未声明 | 2 / 1 | 未归档，最后 push 2023-03-04 | 只写 2 和 3（链接到 3.0.0）；3.1 支持请求 issue #305 未关 |
| `vitest-openapi` | 1.0.3（2023-10-02） | MIT | `>=16` | 2 | 5 star | 只写 2 和 3（链接到 3.0.0） |
| `@seriousme/openapi-schema-validator` | 2.11.0（2026-09-25） | MIT | 未声明 | 4 | active（2026-10-29），0 open issue | 校验**契约文档本身**：2.0 / 3.0 / 3.1 / 3.2 |
| `dredd` | 14.1.0（2021-11-16） | MIT | `>=10` | 23 | **archived**（最后 push 2024-05-11） | OpenAPI 3 标为 experimental，无 3.1 |
| `schemathesis`（PyPI） | 4.32.7（2026-10-27） | MIT | Python `>=3.11` | — | active（2026-10-30） | 2.0 / 3.0 / 3.1 / 3.2 |

## 1. 前端从契约生成 client

### `openapi-typescript` + `openapi-fetch`（openapi-ts 组织）

- 生成物只有**类型**（一个 `.ts` 文件里的 `paths` / `components` 等类型），无运行时代码；README：「Supports OpenAPI 3.0 and 3.1」，「No Java/node-gyp/running OpenAPI servers necessary」。OpenAPI 2.x 只在 5.x 及以前支持。[README](https://github.com/openapi-ts/openapi-typescript/blob/main/packages/openapi-typescript/README.md)
- 运行时 client 是 `openapi-fetch`（直接依赖只有 `openapi-typescript-helpers`），通过泛型从 `paths` 推出请求参数和响应类型；文档要求项目跑 `tsc --noEmit` 才能真正查出类型错误。[openapi-fetch README](https://github.com/openapi-ts/openapi-typescript/blob/main/packages/openapi-fetch/README.md)
- CLI 有 **`--check`**：「Check that the generated types are up-to-date」。这正好对应「门禁校验生成物和契约一致」。CLI 解析时会用 Redocly 规则校验契约（默认 `minimal` 配置，依赖 `@redocly/openapi-core ^1.34.6`）。[docs/cli.md](https://github.com/openapi-ts/openapi-typescript/blob/main/docs/cli.md)
- `typescript ^5.x` 是 peer 依赖。
- 维护：两包最近一次发布都是 2026-02-11（距今约 8.5 个月），仓库 2026-09-25 仍有 push，287 个 open issue/PR。`openapi-fetch` 仍是 0.x。
- 取舍：生成物最小、依赖最少、自带 `--check`；但只给类型和一个薄 fetch 封装，没有 mock 生成，mock 要另配（`openapi-msw` 或 `@msw/source`）。发布节奏比另外两个慢。

### `orval`

- 一个工具同时生成 client（fetch / axios / React Query / SWR / Zod / Hono 等）**和** MSW handler + Faker 数据工厂。README：「generates type-safe JS clients (TypeScript) from any valid OpenAPI v3 or Swagger v2 specification」。v8 起用 `@scalar/openapi-parser` 校验并把 2.0 升级到 3.1 形态；近一年修过多个 3.1 相关问题（`prefixItems`、`type: [..., "null"]`、`$dynamicRef`、`unevaluatedProperties` 等，issue #3697 #3484 #3353 #2156）。[README](https://github.com/orval-labs/orval)、[v8 迁移说明](https://github.com/orval-labs/orval/blob/master/docs/content/docs/versions/v8.mdx)、[MSW 指南](https://github.com/orval-labs/orval/blob/master/docs/content/docs/guides/msw.mdx)
- v8 起纯 ESM，要求 Node ≥ 22.18。
- MSW 生成物依赖 `msw`；mock 数据由 Faker 生成器产出，依赖 `@faker-js/faker`。[Faker 指南](https://github.com/orval-labs/orval/blob/master/docs/content/docs/guides/faker.mdx)
- 生成文件头带「Generated by orval 🍺 / Do not edit manually.」（示例：`samples/basic/api/model/pet.ts`）。没有找到内置的 `--check` 类选项（未穷尽确认），一致性校验要靠「重新生成 + `git diff --exit-code`」。
- 维护：发布非常频繁（2026-10 内 8.40 → 8.45 共 6 个 minor），19 个 open issue。直接依赖 25 个，且多数 `@orval/*` 子包按同版本精确锁定。
- 取舍：client + mock 一个配置搞定，3.1 支持在持续修；代价是依赖面最大、版本跳得快，必须锁精确版本。

### `@hey-api/openapi-ts`

- 插件式生成器（SDK、Fetch/Axios 等 client、Zod、TanStack Query…）。README：「Hey API supports all valid OpenAPI versions and file formats」，「runs in any Node.js 22+ environment」。`engines >=22.18.0`。[README](https://github.com/hey-api/hey-api/blob/main/packages/openapi-ts/README.md)
- **版本策略**：README 原文「This package is in initial development. Please pin an exact version」。迁移文档里有 66 个 `v0.x` 的 breaking 段落；近 12 个月发了 53 个正式版本（0.86.9 → 0.99.0）。[migrating](https://github.com/hey-api/hey-api/blob/main/web/src/content/docs/docs/openapi/typescript/migrating.mdx)
- 有 MSW 插件和 Faker 插件，但文档页标 `status="in-progress"`，MSW 插件页写「MSW v2 support」——而 `msw` 已于 2026-09-28 发 3.0（见下）。[MSW 插件](https://github.com/hey-api/hey-api/blob/main/web/src/content/docs/docs/openapi/typescript/plugins/msw.mdx)、[Faker 插件](https://github.com/hey-api/hey-api/blob/main/web/src/content/docs/docs/openapi/typescript/plugins/faker.mdx)
- 旧的独立 client 包 `@hey-api/client-fetch` 已 deprecated（自 v0.73.0 起 client 打包进 `openapi-ts`）。
- 维护：活跃，但 661 个 open issue/PR（monorepo 含 Python 生成器）。
- 取舍：生成物最「SDK 化」，插件多；0.x 期间每个 minor 都可能 breaking，mock 插件尚未稳定且只写了 MSW v2。

### 生成物提交与否、门禁校验一致性（三者共通的事实）

- 三个工具都是纯 Node 进程，读本地 yaml 文件即可，不需要 Docker 或网络（输入可以直接是 `/context/contract/openapi.yaml`）。
- 一致性校验：`openapi-typescript --check` 是现成的；orval / hey-api 只能「生成到工作区 → `git diff --exit-code`」（推断：前提是生成物提交进仓库且输出确定性，即锁精确版本、格式化步骤固定）。
- 推断（给 #67 的提醒，不是结论）：门禁在全新沙箱里跑，读的是前端仓库的文件；如果门禁要校验「生成物 = 契约 SHA 上的契约」，门禁沙箱也需要拿到同一份契约快照（例如同样挂 `/context/contract/`，或把契约副本一并提交进前端仓库）。现在 `docs/design.md`「门禁」一节没有写门禁沙箱挂契约。

## 2. 前端对着 mock 开发和测试（沙箱里没有 Docker）

### MSW（Mock Service Worker）本体

- 在 Node 里用 `setupServer`（`msw/node`）拦截请求，在浏览器里用 Service Worker（`setupWorker`）；都不需要起 HTTP 服务，更不需要 Docker。
- **3.0.0（2026-09-28）breaking**：ESM-only；最低 Node 22；最低 TypeScript 5.9；`onUnhandledRequest` 改名 `onUnhandledFrame`；不再给假定时器打补丁等。新增 Vite 插件、Node 24/26 支持。[v3.0.0 release](https://github.com/mswjs/msw/releases/tag/v3.0.0)
- 2.x 最后一版 2.15.0（2026-07-08，`engines >=18`）。
- MSW 本身**不读契约**；契约 → handler 要靠下面几种之一。

### 契约 → MSW handler 的几种方式

| 方式 | 怎么用契约 | 响应数据从哪来 | 兼容 msw 3 |
|---|---|---|---|
| `@msw/source` 的 `fromOpenApi()` | 运行时读契约文档，按 `paths` 自动建 handler | 先用契约里的 example，否则用 `@yellow-ticket/seed-json-schema` 按 schema 生成 | 0.7.0 peer `msw ^3.0.0`；0.5.0（旧名 `@mswjs/source`）peer `^2.10.0`，旧名已 deprecated |
| `openapi-msw` | 只在**类型层**用 openapi-typescript 生成的 `paths`：路径、参数、请求体、响应体都被类型约束 | 手写 | peer `msw ^2.10.5 \|\| ^3.0.0` |
| orval 的 MSW 生成器 | 生成期读契约，产出 handler 文件 | Faker 工厂（依赖 `@faker-js/faker`） | 文档未写版本限制（未确认） |
| hey-api 的 MSW 插件 | 生成期读契约 | 手给或配 Faker 插件 | 文档写 MSW v2，状态 in-progress |
| `msw-auto-mock` | CLI 生成 handler | faker，或**调 OpenAI / Azure / Anthropic 生成**（直接依赖 `ai`、`@ai-sdk/*`） | peer `msw >=2` |

来源：[@msw/source 源码 from-open-api.ts](https://github.com/mswjs/source/blob/main/src/open-api/from-open-api.ts)、[open-api-utils.ts](https://github.com/mswjs/source/blob/main/src/open-api/utils/open-api-utils.ts)、[openapi-msw README](https://github.com/christoph-fricke/openapi-msw)、[msw-auto-mock README](https://github.com/zoubingwu/msw-auto-mock)。

- `openapi-msw` 的作者在 README 里说明发版少不代表弃坑；包 0 个直接依赖，1 个 open issue。
- 取舍：`@msw/source` 是 MSW 官方生态、零手写、但 0.x 且响应是随机/示例数据，断言要靠 example 或 `server.use()` 覆盖；`openapi-msw` 把「mock 必须符合契约」交给 `tsc`，但每个 handler 手写；生成器方案（orval / hey-api）mock 和 client 同源，但绑定该生成器的版本节奏。`msw-auto-mock` 的 AI 路径在沙箱里会外呼模型 API，不适合门禁（推断）。

### 需要真 HTTP 服务时（例如 Vite dev server 代理、e2e 前的冒烟）

- **`@msw/serve`**（取代已 deprecated 的 `@mswjs/http-middleware`）：把 MSW handler 起成独立 HTTP 服务或挂到 Express / Hono / Fastify；纯 Node，peer `msw ^3.0.0`。官方 README 自己说「应该优先用 MSW 本身，不必起真服务」。[README](https://github.com/mswjs/serve)
- **Prism**（Stoplight）：`prism mock openapi.yaml` 起一个按契约返回示例/动态数据的 HTTP 服务，也有 `prism proxy` 校验代理。是 Node 进程，不需要 Docker。事实上的约束：
  - 5.15.7（2026-04-17）起 `engines.node >=24.14.0`，5.16.0 起 `>=24.18.0`；最后一个声明支持 Node 18–22 的是 5.14.2（2025-04-17，`>=18.20.1`）。沙箱若是 Node 22，要么锁 5.14.2，要么换 Node 24 镜像（npm 默认对 `engines` 只警告，`engine-strict` 才报错）。
  - 5.16.0 新增依赖 `@scarf/scarf`（postinstall 跑 `report.js` 上报安装统计），可以用 `SCARF_ANALYTICS=false` 或 `DO_NOT_TRACK=1` 关掉。[scarf-js README](https://github.com/scarf-sh/scarf-js)
  - GitHub Release 上 5.15.10 / 5.15.11 附带 `prism-cli-linux` 等单文件二进制，5.16.0 没有附件。
  - 直接依赖里有精确锁定的 `json-schema-faker 0.5.9`、`node-fetch ^2`、`pino ^6`、`yargs ^16` 等较老的库。
  - 来源：npm registry 历史 `engines`；[prism README](https://github.com/stoplightio/prism)；[releases](https://github.com/stoplightio/prism/releases)。

## 3. 后端契约测试（实现和契约一致）

后端是零运行时依赖的 Node `http` 服务，vitest 3。下面都只进 devDependencies。

### 在 vitest 里校验响应

- **`openapi-backend`**：框架无关；`new OpenAPIBackend({ definition })` 后可调 `validateResponse(body, operationId, status)`、`validateResponseHeaders(...)`，也能校验请求和按 schema/example 自动 mock。README 勾选「OpenAPI 3.1 support」。源码细节：校验器用 `import Ajv from 'ajv'`（Ajv 默认类即 draft-07）并设 `strict: false`。推断：3.1 里 draft-07 就有的关键字（`const`、类型数组等）能校验；只在 2020-12 才有的关键字（`prefixItems`、`unevaluatedProperties`、`$dynamicRef` 等）不会报错也不会被校验。[README](https://github.com/openapistack/openapi-backend)、[src/validation.ts](https://github.com/openapistack/openapi-backend/blob/main/src/validation.ts)
- **自己用 Ajv 拼**：Ajv 8.20.0（2026-04-24，MIT，4 个依赖）的 `ajv/dist/2020` 支持 JSON Schema 2020-12，即 OpenAPI 3.1 的方言；需要自己读 yaml（例如 `yaml` 包）、解析 `$ref`、按 path/method/status/content-type 取 schema。最贴 3.1，但胶水代码由我们维护。[Ajv JSON Schema 文档](https://ajv.js.org/json-schema.html)
- **`jest-openapi` / `chai-openapi-response-validator` / `vitest-openapi`**：给断言库加 `toSatisfyApiSpec()` 之类的 matcher。都只声明 OpenAPI 2 和 3（3.0）；上游 OpenAPIValidators 最后发布 2022-01-03，issue #304「Is this project still actively maintained?」、#305「OpenAPI 3.1.0 Support Request」未关，#307 指向第三方维护 fork `ehuelsmann/OpenAPIValidators`。`vitest-openapi` 是对它的薄封装（5 star，最后发布 2023-10）。[jest-openapi README](https://github.com/openapi-library/OpenAPIValidators/tree/master/packages/jest-openapi)、[issue #307](https://github.com/openapi-library/OpenAPIValidators/issues/307)
- **`openapi-response-validator`**（kogosoftwarellc/open-api）：最后发布 2023-05-24，README 没提 3.1，所在 monorepo 有 147 个 open issue。
- **`@seriousme/openapi-schema-validator`**：**不校验响应**，校验的是契约文档本身是否符合 OAS 2.0 / 3.0 / 3.1 / 3.2 的元 schema（带 `validate-api` CLI）。适合当「契约票」的门禁（契约写得合法），不是实现与契约的一致性测试。依赖 `ajv`、`ajv-formats`、`ajv-draft-04`、`yaml`。[README](https://github.com/seriousme/openapi-schema-validator)

取舍（vitest 路线共通）：测试用例由人/agent 写，覆盖面取决于写了哪些请求；好处是和现有 `vitest run` 门禁、JUnit 输出天然一致，纯 Node，无额外运行时。

### 外部工具（对着起好的服务发请求）

- **Schemathesis**（Python）：按契约生成大量请求（property-based，基于 Hypothesis），检查响应是否符合契约、是否 5xx 等；支持 OpenAPI 2.0 / 3.0 / 3.1 / 3.2；能输出 JUnit（`--report junit`，文件名带时间戳，在 `schemathesis-report/` 下）；退出码 1 表示有检查失败，2 表示什么都没测到。安装：`uv tool install schemathesis` / `pip install schemathesis` / 官方 Docker 镜像（沙箱里没 Docker，只能走 pip/uv）。要求 Python ≥ 3.11；依赖里 `jsonschema-rs` 是 Rust 编译的 wheel（PyPI 有 manylinux / musllinux 的 x86_64、aarch64 预编译包），离线安装要提前下好对应平台的 wheel（推断：`pip download` 后 `pip install --no-index`）。[index](https://schemathesis.readthedocs.io/)、[CI/CD 指南](https://github.com/schemathesis/schemathesis/blob/master/docs/guides/cicd.md)、[Docker 指南](https://github.com/schemathesis/schemathesis/blob/master/docs/guides/docker.md)、PyPI `schemathesis` 4.32.7
  - 取舍：覆盖面最广、能发现边界问题，但要在镜像里加 Python 3.11+，要在门禁里先把服务起在端口上，运行时间和结果有随机性（可固定 seed）；默认就会「乱发」请求，对有副作用的接口要配置。
- **Prism `proxy`**：把真实流量过一遍代理，按契约报不一致。同样受 Node ≥ 24 的约束（见上）。
- **Dredd**：仓库已 **archived**（GitHub 显示 archived，最后 push 2024-05-11），最后发布 14.1.0 是 2021-11；OpenAPI 3 支持标为 experimental，无 3.1；依赖已 deprecated 的 `request`。

## 4. 锁版本与离线安装

- 所有 npm 候选都能在 `package.json` 里写精确版本并靠 `package-lock.json` 锁全树；镜像构建时 `npm ci` 把依赖装进去，门禁里的 `setup` 再跑 `npm ci` 时可走 npm 缓存（推断：`npm ci --offline` 需要缓存里已有全部 tarball）。
- 依赖面（直接依赖数）：`openapi-msw` 0、`openapi-fetch` 1、`@msw/serve` 1、`ajv` 4、`@seriousme/...` 4、`openapi-typescript` 6、`@msw/source` 7、`@hey-api/openapi-ts` 10、`openapi-backend` 10、`msw` 12、`prism-cli` 21、`orval` 25。
- 会在安装时联网的：`@stoplight/prism-cli` 5.16.0 的 `@scarf/scarf` postinstall（可用环境变量关）。`msw` 安装后需要 `npx msw init` 把 Service Worker 脚本放进 `public/`（只在浏览器模式需要，Node 测试不需要；文件通常提交进仓库）。
- 官方明确要求锁精确版本的：`@hey-api/openapi-ts`（0.x 每个 minor 可能 breaking）。orval 自己的 `@orval/*` 子包之间已精确锁定。
- Node 版本门槛：`msw` 3 ≥ 22.12，`orval` / `hey-api` ≥ 22.18，`@msw/source` / `@msw/serve` ≥ 22，Prism 最新 ≥ 24.18（5.14.2 及以前 ≥ 18.20.1）。
- Python：只有 Schemathesis 需要，≥ 3.11，外加平台相关的 `jsonschema-rs` wheel。

## 附：契约本身的合法性检查（不是题目里的四问，但门禁会用到）

- `openapi-typescript` 生成时已经用 Redocly 的 `minimal` 规则校验契约。
- `@redocly/cli` 2.72.1（2026-10-29，MIT；npm 上 0 个直接依赖，推断是依赖打包进了发布物）提供 `lint`。
- `@seriousme/openapi-schema-validator`（见上）对照 OAS 元 schema 校验。
