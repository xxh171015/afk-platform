# Postgres 作业队列选型的事实

2026-10-28 · 对应 issue [#4](https://github.com/xxh171015/afk-platform/issues/4)（地图 [#1](https://github.com/xxh171015/afk-platform/issues/1)）

问题：graphile-worker、pg-boss、自己在 Postgres 表上实现，这三种方案能不能满足 `docs/design.md`「作业与恢复」的语义；每种缺什么，补上要多少代码。

调查对象的版本：

- graphile-worker **0.18.0**（npm，2026-09-08 发布）。读的是 npm 包里的 `dist/` 源码和 GitHub `website/docs/`。
- pg-boss **12.38.0**（npm，2026-10-13 发布）。读的是 npm 包里的 `dist/` 源码和 GitHub `docs/`。
- PostgreSQL 文档 18。

本文只陈述事实，最后给出倾向，不替你拍板。

## 一句话结论

graphile-worker（开源版）**不满足**：锁固定 4 小时、不能续期，完成作业时不校验持有者，worker 还必须直连数据库。pg-boss ≥ 12.35 **基本满足**：有心跳、`retryCount` 当 fencing，`fetch/touch/complete` 也可以放在 API 里调；缺的是"按能力集合过滤"，fencing 这个功能也才发布一个月。自己实现**完全满足**，大约 350–450 行生产代码加 300 行测试。倾向自己实现，pg-boss 作为备选。

## 先说一个前提：M3 时队列库只能跑在 API 进程里

「部署」里规定 worker 只出站连 API，不直连数据库。所以无论选哪个库，**库代码都只能跑在 API 进程里**，worker 通过 REST 调 `claim / heartbeat / complete`，由 API 去调库。这样库的 `work()` 轮询循环就用不上了，真正用到的只有"取一条作业 / 续期 / 按 attempt 结算"这三个原语。下面逐项对照时都按这个用法评估。

## 逐项对照

| 语义 | graphile-worker 0.18 | pg-boss 12.38 | 自己实现 |
| --- | --- | --- | --- |
| `FOR UPDATE SKIP LOCKED` 取作业 | 有 | 有 | 有（自己写） |
| 2 分钟租约 + 30 秒心跳续期 | **没有**：锁固定 4 小时，没有续期 API（心跳在收费的 Pro 版里） | 有：`heartbeatSeconds` + `touch()`；回收延迟是租约时长加最多一个 `monitorIntervalSeconds` | 有 |
| 租约过期回到队列，attempt+1 | 4 小时后回到队列；`attempts` 在领取时 +1 | 心跳超时后转成 `retry`，再被领取时 `retryCount`+1；**会消耗 `retryLimit`** | 有 |
| attempt 当 fencing token | **不行**：完成作业时只按 id 删除，不看持有者 | **可以**（≥ 12.35.0）：传 `{id, retryCount}` 时只对当次 attempt 生效 | 可以，能和业务写入放在同一个事务里 |
| 幂等键唯一约束 | 三种方案都应该放在平台自己的 `stage_result` 表上；`job_key` 只在作业等待中或失败时唯一，完成的作业会被删掉 | 同左；`singletonKey` 只是入队去重 | 同左 |
| 能力标签 | 部分满足：按 task identifier 过滤，再加 `forbiddenFlags`（黑名单） | 部分满足：只能"一个能力组合一个队列"，一次 fetch 只查一个队列 | 满足：`required_caps <@ $worker_caps` |
| 与 advisory lock 共存 | 不冲突：运行时不用 advisory lock | 不冲突：只用事务级锁，key 是 64 位哈希；我们用两个 int4 的键空间就和它完全隔开 | 不冲突 |
| worker 不直连数据库（M3） | **不行**：没有公开的"取一条作业"原语，跑作业的进程必须连库 | 可以：API 里调 `fetch/touch/complete`；官方还有 `@pg-boss/proxy` HTTP 代理 | 可以（本来就是这么设计的） |
| 活跃度 | 活跃：最近 3 个月约 50 个 commit；主要是 benjie 一个人维护；版本还是 0.x | 很活跃：最近 3 个月超过 100 个 commit、发了约 20 个版本；主要是 timgit 一个人维护；schema 已经到 v46，迁移频繁 | 不适用 |
| 许可证 | MIT（Pro 版是专有的） | MIT | 不适用 |
| TypeScript | 源码是 TS，自带类型；payload 默认是 `unknown` | 源码是 TS，自带类型 | 不适用 |
| 运行时要求 | PostgreSQL 12+，Node 22.18+ | Node 22.12+ | 不适用 |

下面给出每一项的出处。

## graphile-worker 0.18.0

**取作业。** `dist/sql/getJobs.js` 构造的查询是 `select … from _private_jobs where is_available = true and run_at <= now() and task_id = any($2) [and (flags ?| $3) is not true] order by priority, run_at limit N for update skip locked`，然后执行 `update … set attempts = attempts + 1, locked_by = $1, locked_at = now()`。所以 attempt 是在领取时加一的。

**租约与续期。** 没有租约时长这个参数。过期锁靠 `dist/sql/resetLockedAt.js` 定期清理，SQL 里把 `locked_at < now() - interval '4 hours'` 写死了；清理间隔是 `minResetLockedInterval` 和 `maxResetLockedInterval`，默认 8–10 分钟（`dist/config.js`）。`dist/*.d.ts` 里找不到任何续期、心跳、extend 之类的 API。官方文档 `website/docs/pro/recovery.md` 原话：worker 异常退出时作业"remain locked for up to 4 hours"，"Worker Pro tracks running workers via a heartbeat"。Pro 版要赞助才能用，见 `website/docs/pro/index.md`：*"Worker Pro (`@graphile-pro/worker`) is a proprietary (not open source) preset"*。

**fencing。** `dist/sql/completeJobs.js` 对不属于命名队列的作业执行 `delete from _private_jobs where id = $1`，**没有校验 `locked_by`，也没有校验 attempts**。`failJobs.js` 会校验 `locked_by = poolId`，但这只是 worker 池的 id，不是 attempt。也就是说，一个过期的旧进程完成作业时，会把另一个进程正在跑的同一个作业删掉。`WorkerUtils.completeJobs(ids)` 同样只认 id（`dist/interfaces.d.ts`）。

**没有对外的取作业原语。** `dist/index.d.ts` 对外导出的是 `run / runOnce / runTaskList / makeWorkerUtils / quickAddJob`。`WorkerUtils` 有 `completeJobs`、`permanentlyFailJobs`、`rescheduleJobs`、`forceUnlockWorkers`，但没有"取一条作业"。作业只能在连着数据库的 runner 进程里，由 task handler 执行。要在 M3 用它，只能让 API 里的 runner 代替远端 worker 占着锁、等结果，而这把锁最长 4 小时，还不能续期。

**幂等键。** `website/docs/job-key.md`：`job_key` 只在作业等待中或失败时唯一，作业完成后行就删了；作业运行时再用同一个 key `add_job`，会另外排一个新作业，两个都会跑（`unsafe_dedupe` 模式除外）。所以它只能用来入队去重，不能当阶段幂等记录。

**能力标签。** runner 只会领取自己注册了 handler 的 task（上面查询里的 `task_id = any($2)`）。另外，`website/docs/forbidden-flags.md` 允许作业带 `flags`，worker 用 `forbiddenFlags` 声明自己不接哪些 flag。这是黑名单，worker 得知道全部 flag 有哪些，才能列出自己缺的。

**命名队列。** `website/docs/sql-add-job.md`：同一个 `queue_name` 里的作业一次只跑一个。这个特性可以拿来把同一个集成分支上的写操作串行化，但它同样受 4 小时锁的限制。

**advisory lock。** 在 `dist/` 里 grep `advisory`，没有结果。

**维护情况。** `website/docs/project-status.md`：*"Production ready … hence the 0.x numbering; updating to a new minor version may require some small code modifications"*。0.17.0 在 2026-06-12 发布，0.18.0 在 2026-09-08 发布（改成纯 ESM，配置改用 `graphile.config.ts`）。GitHub 2.4k star，最近一次 push 是 2026-10-20。贡献者里 benjie 有 1301 个 commit，第二名 167 个。`website/docs/requirements.md`：PostgreSQL 12+，Node 22.18+。

## pg-boss 12.38.0

**取作业。** `dist/plans.js` 的 `fetchNextJob()`：`WITH next AS (SELECT … WHERE name = $queue AND state < 'active' AND NOT blocked AND start_after <= job_now() ORDER BY priority desc, created_on LIMIT n FOR UPDATE OF j SKIP LOCKED) UPDATE … SET state = 'active', started_on = job_now(), heartbeat_on = job_now(), retry_count = CASE WHEN started_on IS NOT NULL THEN retry_count + 1 ELSE retry_count END`。

**心跳与租约。** 队列或作业级的 `heartbeatSeconds` 至少是 10（`dist/attorney.js` 里有断言 `heartbeatSeconds must be an integer >= 10`）。`touch(name, job)` 会刷新 `heartbeat_on`。监控进程用 `heartbeat_on + heartbeat_seconds < job_now()` 判断心跳丢失，然后把作业 fail 掉（`plans.js` 的 `heartbeatLost()` 和 `failJobsByHeartbeat()`）。`docs/api/queues.md` 原话：*"Actual detection time is `heartbeatSeconds` + up to `monitorIntervalSeconds` (default 60s)"*。所以"2 分钟租约"对应 `heartbeatSeconds: 120`，把 `monitorIntervalSeconds` 调到 10–15 秒，回收延迟大约 2 分 15 秒。

- `expireInSeconds` 是另一套独立的上限，从作业开始时算起（`started_on + expire_seconds`），默认 900 秒，最大 24 小时（`attorney.js` 里的 `MAX_EXPIRATION_HOURS: 24`）。agent 一次可能跑一小时，所以要设成 7200 秒左右。
- 心跳丢失走的是普通失败路径：`retry_count < retry_limit` 时转成 `retry`，否则转成 `failed`（`plans.js` 的 `failJobsBody()`），所以**每次租约丢失都会消耗一次 `retryLimit`**，默认只有 2 次。PoC 电脑经常休眠，要把它调大（比如 50），`retryDelay` 设为 0。重试用完后作业会变成 `failed`，平台自己的调度器要接住这个状态，转成 blocked。
- 过期检测由开着 `supervise`（默认 true）的实例负责，放在 API 进程里正好。

**fencing。** 从 **12.35.0（2026-09-26）** 开始支持。release notes 原话：*"A worker whose claim on a job lapsed can no longer complete, fail or heartbeat the attempt that replaced it"*。实现在 `plans.js` 的 `attemptFence()`：`AND state = 'active' AND (id::text || ':' || retry_count::text) = ANY($n)`，`completeJobs`、`failJobsById`、`touchJobs` 都带这个条件。`docs/api/jobs.md`「Passing jobs instead of ids」说明，`complete/fail/touch/cancel/deleteJob` 传 `{id, retryCount}` 时只作用于当次 attempt，不匹配就返回 `affected: 0`。类型注释（`dist/types.d.ts`）原话：`retryCount` *"also identifies the attempt a worker is holding"*。

- 所有方法都接受 `{ db }` 参数（`ConnectionOptions`），所以可以在同一个业务事务里先调 `touch({id, retryCount}, { db: tx })`，`affected = 0` 就回滚，用这种方式给"回传结果、记录推送"这类业务写入做 fencing，不需要碰 pg-boss 的内部表。
- 有一个边界：作业已经过期、但监控进程还没扫到时，旧 attempt 仍然是 `active`，这时它的写入会被接受。不过在这段窗口里，没有别的进程能领到这个作业，所以"同一时刻只有一个持有者"不会被破坏。
- 这个功能才发布一个月，是这次调查里最新的一块。

**worker 不连库。** 在 API 里直接调 `fetch / touch / complete` 就行。官方还有一个 `@pg-boss/proxy`（`docs/proxy.md`），把这些方法包成 JSON HTTP 接口，带 OpenAPI 和 basic auth。但它只是方法级的代理，fencing 业务写入、能力匹配还得写在我们自己的 API 里，所以不建议直接拿它当平台 API。

**幂等键。** `singletonKey` 配合 `singleton/stately` 等队列策略，只能对"排队中 / 运行中"的作业去重（`docs/api/queues.md`），是入队去重，不是阶段结果的幂等记录。完成的作业默认保留 7 天（`deleteAfterSeconds`）后删除。

**能力标签。** fetch 的过滤条件只有队列名、优先级范围和 `ignoreGroups`（`types.d.ts` 的 `FetchOptions`）。能力只能编进队列名，比如 `ticket-stage.<repo>`，worker 按自己能访问的仓库逐个 fetch。跨队列的优先级要自己处理，能力组合一多，队列数量也会跟着膨胀。

**advisory lock。** 只用 `pg_advisory_xact_lock` 或 `pg_try_advisory_xact_lock`（事务级，事务结束就释放），key 是 `sha224(current_database() || '.pgboss.' || schema || key)` 截成的 64 位整数（`plans.js` 的 `advisoryLockKey()`）。

**维护情况。** 12.x 版本密集发布，9 月到 10 月几乎每周一个，schema 版本已经到 46，很多小版本都带迁移（`Schema version: **46**. A migration runs on upgrade`）。GitHub 4.1k star，最近一次 push 是 2026-10-27。贡献者里 timgit 有 1669 个 commit，第二名 106 个。

## advisory lock 共存，以及 M3 的一个隐患

**共存没有问题。** PostgreSQL 18 文档（Advisory Lock Functions）原话：*"identified either by a single 64-bit key value or two 32-bit key values (note that these two key spaces do not overlap)"*。集成分支锁用两个 int4 的形式，比如 `pg_advisory_lock(<平台常量>, hashtext(repo || '/' || branch))`，就和 pg-boss 的单 64 位键完全隔开了。graphile-worker 本来就不用 advisory lock。

**隐患与选哪个队列无关，但这次顺带确认了。** 文档原话：session 级 advisory lock *"held until released or the session ends"*。M3 时持锁的是 worker，可它没有数据库连接，只能由 API 替它占住一条专用连接，跨好几次 HTTP 请求一直持有，门禁可能要跑几分钟。API 一重启，锁就丢了，而远端 worker 并不知道。PgBouncer 文档（features）在 transaction pooling 模式下对 session-level advisory locks 标的是 "Never"。

两种可行的替代：

1. 把锁做成一张租约表，持锁者带 (job id, attempt)，和作业用同一套 fencing。
2. 把写集成分支的步骤做成按"仓库 × 集成分支"串行的作业：pg-boss 用 `groupConcurrency: 1`，自己实现就加一个 `lock_key` 唯一约束。

建议另开一张票，修改「Git 操作规范」里的集成分支锁。

## 自己实现：最小方案草图

### 表结构

```sql
create table job (
  id               bigserial primary key,
  kind             text        not null,              -- ticket-stage / update-branch / finalize ...
  payload          jsonb       not null,
  required_caps    text[]      not null default '{}', -- {'docker','repo:backend'}
  dedupe_key       text        unique,                -- 入队去重，例如 'ticket-stage:T-123:v3:implement:1'
  priority         int         not null default 0,
  state            text        not null default 'queued'
                   check (state in ('queued','leased','done','failed','cancelled')),
  attempt          int         not null default 0,    -- fencing token
  max_attempts     int         not null default 50,
  run_after        timestamptz not null default now(),
  leased_by        text,
  lease_expires_at timestamptz,
  last_error       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);
create index job_ready  on job (priority desc, id) where state = 'queued';
create index job_leased on job (lease_expires_at)  where state = 'leased';

-- 阶段幂等记录：平台自己的表，和队列无关
create table stage_result (
  ticket_id text, content_version int, stage text, seq int,
  job_id bigint not null, attempt int not null, result jsonb not null,
  primary key (ticket_id, content_version, stage, seq)
);
```

### 取作业

worker 调 `POST /jobs/claim {workerId, caps}`，API 在一个事务里执行下面的 SQL。过期租约直接在取作业时一起回收，不需要单独的清扫进程：

```sql
with c as (
  select id from job
  where ((state = 'queued' and run_after <= now())
         or (state = 'leased' and lease_expires_at < now()))
    and required_caps <@ $1::text[]          -- 作业要的能力，worker 全都有
    and attempt < max_attempts
  order by priority desc, id
  limit 1
  for update skip locked
)
update job j
   set state = 'leased', attempt = j.attempt + 1, leased_by = $2,
       lease_expires_at = now() + interval '2 minutes', updated_at = now()
  from c where j.id = c.id
returning j.id, j.attempt, j.kind, j.payload;
```

另外还需要一条低频 SQL，把 `attempt >= max_attempts` 的过期作业标成 `failed`，再交给调度器转成 blocked。

### 心跳

worker 每 30 秒调一次 `POST /jobs/:id/heartbeat {attempt}`：

```sql
update job set lease_expires_at = now() + interval '2 minutes', updated_at = now()
 where id = $1 and attempt = $2 and state = 'leased' and lease_expires_at > now()
returning lease_expires_at;
```

返回 0 行时 API 回 409，worker 收到后用 `AbortSignal` 中止本地运行。这里额外要求 `lease_expires_at > now()`：租约过期后，即使作业还没被别人领走，也拒绝旧进程续期。这和设计里"睡醒后旧进程被拒绝"一致。

### fencing 校验

回传结果、登记推送这类业务写入，和校验放在同一个事务里：

```sql
begin;
select 1 from job
 where id = $1 and attempt = $2 and state = 'leased' and lease_expires_at > now()
 for update;                                   -- 0 行：回滚，返回 409
insert into stage_result (...) values (...) on conflict do nothing;   -- 幂等
update job set state = 'done', updated_at = now() where id = $1 and attempt = $2;
commit;
```

`for update` 和取作业里的 `for update skip locked` 是互斥的：fencing 事务进行中时，这一行不会被别人回收领走。推送集成分支是一次外部副作用，没法放进数据库事务，所以"校验通过以后才推送"之间仍有一个很小的窗口，靠设计里已有的 `--force-with-lease=<预期旧 SHA>` 兜底。pg-boss 方案也一样存在这个窗口。

### 代码量（估算，TypeScript）

| 部分 | 行数 |
| --- | --- |
| 迁移 SQL（job、stage_result、索引） | 约 40 |
| API 端的 job repository：enqueue（去重）、claim、heartbeat、complete、fail（退避重试）、cancel、标记重试耗尽 | 约 200–250 |
| REST 路由与校验（claim / heartbeat / complete / fail） | 约 60–80 |
| worker 端客户端：拉取循环、30 秒心跳定时器、遇到 409 就 abort、退出时清理 | 约 80–120 |
| 测试：并发领取不重复、租约过期后重领、旧 attempt 写入被拒、能力过滤、幂等重放 | 约 300 |

生产代码大约 **350–450 行**，测试大约 300 行。

### 各方案要补的代码

- **自己实现**：上面就是全部，再加上集成分支锁的租约表，约 50–80 行。
- **pg-boss**：
  - API 包装 `fetch / touch / complete / fail` 约 100–150 行；
  - 能力到队列名的映射和多队列轮询约 50 行；
  - 业务写入的 fencing 用 `touch(..., { db: tx })` 约 30 行；
  - 重试耗尽后的处理约 30 行。

  合计约 **200–250 行**，测试量相近。得到的额外好处是 dashboard、OTel、保留策略、死信队列。代价是要跟它频繁的 schema 迁移；"一次领取同时匹配多个能力"做不到；fencing 是一个月前才加的功能。
- **graphile-worker**：缺的是 2 分钟租约续期、带 attempt 的完成校验、对外的领取原语，这三样都在库的核心路径上。要补的话，要么买 Pro 版拿心跳，要么直接改它的 `_private_jobs`（文档明确说内部表是私有的）。补完基本等于把队列重写一遍，**不建议**。

## 倾向（供拍板参考）

倾向**自己实现**，理由有四个：

1. M3 的部署形态要求库只能跑在 API 里，库的 worker 循环、LISTEN/NOTIFY 这些主要价值都用不上，剩下的就是几条 SQL。
2. 能力匹配用 `<@` 一条查询就能完成，fencing 校验能和业务写入、阶段幂等记录放在同一个事务里，语义直接对应设计。
3. 作业量很小（每小时几十个），不需要库的吞吐优化。
4. 约 400 行代码，配齐测试后语义完全可控，不用跟第三方的 schema 迁移。

**pg-boss 是可行的备选**：如果更看重现成的监控、重试和保留策略，它在 12.35 以后已经能覆盖租约、心跳和 fencing，补的代码更少，但要锁定 ≥ 12.35 的版本，并在 M1 用"休眠—唤醒"场景实测 fencing。

**graphile-worker 排除**。

## 来源

- graphile-worker npm 包 0.18.0：`dist/sql/getJobs.js`、`dist/sql/resetLockedAt.js`、`dist/sql/completeJobs.js`、`dist/sql/failJobs.js`、`dist/config.js`、`dist/interfaces.d.ts`、`dist/index.d.ts`、`dist/generated/sql.js`
- graphile-worker 文档（GitHub `graphile/worker` 的 `website/docs/`）：[pro/recovery.md](https://github.com/graphile/worker/blob/main/website/docs/pro/recovery.md)、[pro/index.md](https://github.com/graphile/worker/blob/main/website/docs/pro/index.md)、[job-key.md](https://github.com/graphile/worker/blob/main/website/docs/job-key.md)、[forbidden-flags.md](https://github.com/graphile/worker/blob/main/website/docs/forbidden-flags.md)、[sql-add-job.md](https://github.com/graphile/worker/blob/main/website/docs/sql-add-job.md)、[requirements.md](https://github.com/graphile/worker/blob/main/website/docs/requirements.md)、[project-status.md](https://github.com/graphile/worker/blob/main/website/docs/project-status.md)、[typescript.md](https://github.com/graphile/worker/blob/main/website/docs/typescript.md)；[v0.18.0 release](https://github.com/graphile/worker/releases/tag/v0.18.0)
- pg-boss npm 包 12.38.0：`dist/plans.js`（`fetchNextJob`、`attemptFence`、`completeJobsUpdate`、`touchJobs`、`heartbeatLost`、`failJobsBody`、`advisoryLockKey`）、`dist/types.d.ts`、`dist/attorney.js`、`LICENSE`
- pg-boss 文档（GitHub `timgit/pg-boss` 的 `docs/`）：[api/queues.md](https://github.com/timgit/pg-boss/blob/master/docs/api/queues.md)（Heartbeat vs expiration）、[api/jobs.md](https://github.com/timgit/pg-boss/blob/master/docs/api/jobs.md)（Passing jobs instead of ids、touch）、[api/workers.md](https://github.com/timgit/pg-boss/blob/master/docs/api/workers.md)、[api/constructor.md](https://github.com/timgit/pg-boss/blob/master/docs/api/constructor.md)、[proxy.md](https://github.com/timgit/pg-boss/blob/master/docs/proxy.md)；[12.35.0 release](https://github.com/timgit/pg-boss/releases/tag/12.35.0)、[12.38.0 release](https://github.com/timgit/pg-boss/releases/tag/12.38.0)
- npm registry：`npm view graphile-worker` / `npm view pg-boss`（版本、发布时间、license、engines）；GitHub API（star、最近 push、贡献者）
- [PostgreSQL 18：Advisory Lock Functions](https://www.postgresql.org/docs/current/functions-admin.html#FUNCTIONS-ADVISORY-LOCKS)
- [PgBouncer：Features（各 pooling 模式支持的 SQL 特性）](https://www.pgbouncer.org/features.html)
