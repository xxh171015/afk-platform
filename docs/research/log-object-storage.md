# 自建的日志和对象存储选型（2026）

调研票 #201（地图 #196）。调研日期 2026-11-08。外部事实都核对过一手资料（项目仓库、release、README、许可证、官方定价页），链接附在每条后面；仓库内的事实给出文件路径；量级来自用户 Mac 上平台的真实数据（只读统计）。

## 结论

1. **M3 不引入对象存储。** 要集中存的只有 Run 日志，而日志早已经由 worker 用 HTTP 推给 API（`POST /worker/runs/{id}/logs`），worker 只需要出站，正好符合 M3 的「构建机只出站」。API 继续把日志写在**平台服务器的磁盘**上（compose 里挂一个具名卷，`AFK_LOG_DIR` 指向它），就已经是集中存储。
2. **上下文目录和快照不需要集中存。** `/context` 是 worker 每次运行时按 API 下发的 bundle 加上 git 现渲染的临时目录；`/refs` 快照是 worker 用 `git archive` 从固定 SHA 导出的本机缓存，已有 7 天清理。两者都能随时从 Postgres + Git 重建，搬到中心存储只会多一跳网络、不增加可追溯性。
3. **量级很小。** 真实数据：一周 10 个需求、50 份日志共 13.9 MiB，每个需求约 1.4 MiB，单份日志最大 1.47 MiB（上限 50 MiB 的 3%）。按 5 个团队、每团队每周 10 个需求估算，一年约 **3.6 GiB**，放大 5 倍也只有约 **18 GiB**；保留 90 天时稳态 1–5 GiB。一块普通服务器磁盘绰绰有余。
4. **MinIO 社区版已不适合自建：** 上游仓库 2026-04 已归档、README 写明「不再维护」；2025-10 起只发源码不发二进制；2025-05 起社区版控制台只剩对象浏览；Docker Hub 上的 `minio/minio`、`minio/mc` 现在都查不到了。官方给的替代 AIStor Free 是闭源的商业许可、只支持单节点。`docs/design.md` 和 `log-store.ts` 注释里「服务器上换 MinIO」的说法应在 M3 spec 里改掉。
5. **将来真的需要对象存储时**（M5 存 agent 会话记录、API 多副本、或者日志量大了两个数量级），首选 **SeaweedFS**（Apache-2.0、发版活跃、`weed mini` 单进程可用于单节点生产、生命周期规则齐全）；**Garage**（AGPL-3.0、轻量、活跃）是第二选择，但生命周期只支持 `Expiration` 和清理未完成分片、没有版本控制。MinIO 的社区分支 Silo、刚 GA 的 RustFS 先不选。为这一天准备的只是让 `LogStore` 保持现在的窄接口。
6. **M3 要补的是保留策略和磁盘可见性，不是新的存储：** 服务器上日志按需求结束时间保留（建议 90 天，可配）、在系统状态面板显示日志目录大小；构建机上 Sandcastle 的原始日志目录 `sandbox-logs`（未脱敏、目前从不清理）要按天数清理，它只留在构建机上、不上传。

## 1. 现状：日志、上下文目录、快照各在哪里

### Run 日志（要集中存的东西）

- 写：worker 的 `LogUploader` 每 5 秒把缓冲的行发给 API（`packages/worker/src/worker.ts`，`logFlushMs` 默认 5000）；每块不超过 1 MiB（`packages/shared/src/logs.ts` 的 `MAX_LOG_CHUNK_BYTES`）。worker 侧在发送前对原始流做了脱敏（`packages/worker/src/executor.ts` 里 `sanitizeRawLine`）。
- 收：`packages/api/src/http/log-routes.ts`。追加前按 job 的租约和 attempt 做 fencing（不是当前持有者回 409），写满回 413，worker 把 413 当作「继续干活」（`packages/worker/src/api.ts`）。
- 存：`packages/api/src/logs/log-store.ts`。一个 (run, attempt) 一个文件 `run-<id>/attempt-<n>.log`，同一文件的追加串行化；每个 attempt 上限 50 MiB（`MAX_LOG_BYTES`）。目录是 `$AFK_LOG_DIR`，否则 `~/.afk/logs/<instance id>`。
- 读：`GET /runs/{id}/logs?offset&limit&attempt`，按字节偏移分片读（默认 256 KiB，最多 4 MiB），切口落在 UTF-8 字符边界上；页面和 `plat logs` 都走这个接口。

也就是说，**worker 本来就不碰日志目录**，日志的「集中」在 M1 起就已经是 API 的事。M3 把 worker 挪到别的机器上，这条路径不用改，只要 worker 能出站连到 API。

日志这种负载适合放文件：它是**边写边追加、按偏移续读**的。S3 没有追加操作，换成对象存储要么在 API 里缓冲到 attempt 结束再整体上传（运行中的日志就得另找地方读），要么每块存成一个对象再拼（读一段要列对象、算偏移）。两种都比现在的文件复杂，换来的只是我们暂时用不到的横向扩展。

### 上下文目录（不需要集中存）

- `/context` 由 worker 在每次运行前渲染到临时目录（`packages/worker/src/executor.ts` 的 `renderFor`），内容来自 API 的 bundle（`packages/api/src/stages/bundle.ts`：票、spec、契约指针、refs、review 结果等）和 git（契约原文用 `git show <sha>:<path>` 读，平台不存契约正文）。
- bundle 的来源全在 Postgres，契约和代码在 Git，所以任何一次运行的上下文都能按 Run 上记的 SHA 重新生成。要「留证」的话，比把整个目录上传更便宜的做法是在 Run 上记 bundle 的版本或摘要——这是 M4 追溯的话题，不在本票。
- Mac 上的 `~/.afk/context` 只有 88 KB，是 M0 演练留下的。

### 快照（不需要集中存）

- `/refs/<仓库>` 的只读快照是 worker 用 `git archive` 从固定 SHA 导出的本机目录（`packages/worker/src/snapshots.ts`），已按 7 天未用清理（`SNAPSHOT_MAX_AGE_MS`、`pruneSnapshots`，`packages/worker/src/main.ts` 启动时调用）。
- 每台构建机有自己的主 clone，快照在本机生成最快；中心化反而要把整个源码树经网络搬一次。

### 构建机上留下的其他东西

- `~/.afk/sandbox-logs/<时间>-<槽位>/`：Sandcastle 自己写的原始日志，含 `*.stream.jsonl`（`packages/worker/src/main.ts` 的 `logDir`）。这份**未经脱敏**，不应上传；目前没有任何清理。Mac 上一周 75 个目录、48 MB，单个最大 3.7 MB。M3 要给它加按天数清理（例如和快照一样 7 天，或 14 天）。
- `~/.afk/repos`（主 clone）、`~/.afk/slots`（槽位）是工作目录，不属于本票。

## 2. 量级

### 实测（2026-11-08 只读统计，用户 Mac 上的平台，instance `ba6752`）

| 指标 | 数值 |
| --- | --- |
| 时间范围 | 2026-10-29 至 2026-11-05（约 7 天） |
| 需求 / 票 / Run | 10 个需求（5 个已合并）/ 25 张票 / 123 次 Run |
| 有日志的 attempt | 50 份文件，共 14,564,023 字节（13.9 MiB） |
| 单份日志 | 中位数 0.29 MiB，P90 0.58 MiB，最大 1.47 MiB |
| 每个需求 | 约 1.4 MiB 日志、约 5 份日志 |
| 构建机 `sandbox-logs` | 75 个目录，48 MB（只在构建机上） |

最大的一份也只用了每 attempt 上限（50 MiB）的 3%。

### 一年要多少空间

| 场景 | 假设 | 一年 |
| --- | --- | --- |
| 估计值 | 5 个团队 × 每周 10 个需求 × 52 周 = 2600 个需求，每个 1.4 MiB | 约 3.6 GiB |
| 保守 | 上面 × 5（需求更大、重试更多、agent 输出更啰嗦） | 约 18 GiB |
| 理论上限 | 2600 个需求 × 5 份日志 × 每份写满 50 MiB | 约 635 GiB |

每团队每周 10 个需求已经偏高（试点那一周是一个人集中推进）。理论上限不会出现，但可以拿来定磁盘告警线。日志是纯文本，结束后压缩一般还能再小几倍，量级这么小时不值得做。

**保留 90 天**时稳态约为一年量的四分之一：估计 1 GiB，保守 5 GiB。

## 3. MinIO 现状（按一手资料核实）

| 时间 | 事实 | 来源 |
| --- | --- | --- |
| 2025-05-09 | 社区版合入新控制台（`minio/console` v1.7.6 → v1.7.7 预发布版），PR 自己勾选「Breaking change」；此后社区版控制台只剩对象浏览，账户、策略、桶配置等管理要用 `mc` | [minio/minio#21278](https://github.com/minio/minio/pull/21278)；功能清单见 [Blocks & Files 报道](https://blocksandfiles.com/2025/06/19/minio-removes-management-features-from-basic-community-edition-object-storage-code/)（二手） |
| 2025-10-15 | README 改为「社区版只发源码，不再提供预编译二进制」，要么 `go install`，要么自己用 Dockerfile 构建镜像；旧二进制「不会再有更新」 | [commit 9e49d5e](https://github.com/minio/minio/commit/9e49d5e7a6)、[README](https://github.com/minio/minio#source-only-distribution) |
| 2025-10-16 | 最后一个 release：`RELEASE.2025-10-15T17-29-55Z`（Security/CVE） | [releases](https://github.com/minio/minio/releases) |
| 2025-12-03 | README 加「Maintenance Mode」：不接受新改动，安全修复「视情况」 | [commit 27742d4](https://github.com/minio/minio/commit/27742d4694) |
| 2026-01-06 | README 指向 AIStor Free / AIStor Enterprise | [commit be7800c](https://github.com/minio/minio/commit/be7800c813) |
| 2026-02-12 | README 改为「THIS REPOSITORY IS NO LONGER MAINTAINED.」 | [commit 7aac2a2](https://github.com/minio/minio/commit/7aac2a2c5b) |
| 2026-04 | 仓库归档（GitHub API `archived: true`，最后推送 2026-04-24） | [minio/minio](https://github.com/minio/minio) |
| 2026-11-08 | Docker Hub 上 `minio/minio`、`minio/mc` 的仓库 API 都返回 404 `object not found`（同一时刻 `pgsty/silo`、`chrislusf/seaweedfs`、`dxflrs/garage` 正常）；`minio/console` 的 GitHub 仓库也是 404 | 本次直接查询 `https://hub.docker.com/v2/repositories/minio/minio/`；据二手报道镜像在 2026-09 被删（[jacar.es](https://jacar.es/en/fix-pull-access-denied-minio-docker/)） |

许可证：社区版是 AGPL-3.0（[LICENSE](https://github.com/minio/minio/blob/master/LICENSE)）。我们只在内部不加修改地跑它，AGPL 本身不是障碍；问题在于**没人维护、没有可拉的镜像、没有安全更新**。

AIStor Free：官方定价页写明免费、**仅单节点**、「commercially licensed」、禁止再分发，支持只有社区 Slack 和文档（[min.io/pricing](https://www.min.io/pricing)）。闭源商业许可加上厂商随时可改条款，不适合做平台的地基。

社区分支 **Silo**（原 `pgsty/minio`，2026-08-06 改名）：AGPL-3.0，恢复了完整控制台、发二进制和多架构镜像，2026-10-26 还在发版（[pgsty/silo](https://github.com/pgsty/silo)）。可用，但维护方是一家公司（Pigsty），而且 MinIO 本身对我们这个量级偏重；只在「必须兼容 MinIO 数据格式」时才值得考虑，我们没有这个包袱。

## 4. 替代方案

| | SeaweedFS | Garage | RustFS | 不用对象存储（API 写服务器磁盘） |
| --- | --- | --- | --- | --- |
| 许可证 | Apache-2.0 | AGPL-3.0 | Apache-2.0 | — |
| 近况 | 2026-11-02 发 4.52，近半年每月 1–7 个版本；GitHub 约 3.6 万星 | 2026-10-24 发 v2.5.0（稳定版），v2.x 线 2025 年起持续发版 | 1.0.0 在 2026-09-16 才 GA，之前一直是 alpha/beta/rc | 现有代码 |
| 单节点 | `weed mini -dir=…` 一个进程，README 写「fine for single-node production」 | 单节点可跑，设计目标是小规模、多地点 | 可以 | 就是一个卷 |
| 生命周期 / 过期 | 支持（README 列出 versioning、object lock、lifecycle rules） | 部分：只支持 `Expiration` 和 `AbortIncompleteMultipartUpload`；没有版本控制、对象锁、桶策略 | 支持 | 平台自己按需求结束时间删目录 |
| 追加写、按偏移续读 | 无追加（S3 语义） | 无追加 | 无追加 | 原生支持，现有代码已实现 |
| 运维量 | 多一个服务、一套 AK/SK、一份要备份的数据；默认凭证和管理端口要关好（README 专门提醒 Admin UI 绑定） | 多一个服务；布局（layout）要初始化 | 多一个服务；项目年轻 | 零新增 |

来源：[seaweedfs/seaweedfs](https://github.com/seaweedfs/seaweedfs)（README、[releases](https://github.com/seaweedfs/seaweedfs/releases)）；Garage [仓库与 release](https://git.deuxfleurs.fr/Deuxfleurs/garage/releases)、[LICENSE](https://git.deuxfleurs.fr/Deuxfleurs/garage/src/branch/main-v2/LICENSE)、[S3 兼容性表](https://garagehq.deuxfleurs.fr/documentation/reference-manual/s3-compatibility/)（该页自称部分条目可能过时）；[rustfs/rustfs](https://github.com/rustfs/rustfs)（README、[releases](https://github.com/rustfs/rustfs/releases)）。

### 为什么 M3 选「API 写服务器磁盘」

- **它已经在跑。** worker → API 的上传、fencing、上限、分片续读都有、都有测试；M3 只需在 compose 里给 API 挂卷。
- **负载形状吻合。** 追加写、按偏移读，文件天然支持，S3 不支持。
- **规模不需要。** 一年几 GiB，单块盘、一个目录足够；API 在 M3 是单实例，不存在多副本共享文件的问题。
- **少一个要运维的服务。** 运维目前是用户一个人。对象存储意味着又一个容器、一套凭证、一份备份和一个升级节奏——还偏偏碰上 MinIO 停摆、要重新选型的时候。

### 什么时候再上对象存储

出现下面任一情况时：

- M5 换成能采集会话记录的 agent，要存大块的二进制或 JSONL 会话记录（`docs/design.md` 已把「会话记录存对象存储」放在 M5）。
- API 要多副本，或者日志要给平台之外的系统直接读。
- 日志量比估计值大两个数量级（上百 GiB/年），单盘吃紧。

到时首选 SeaweedFS，其次 Garage。实现上是给 `LogStore` 换一个后端：运行中的 attempt 仍写本地文件，attempt 结束后整体上传并删本地文件，读的时候先找本地、再找对象存储。今天能做的准备只有一条：**别让 `LogStore` 的接口长出文件系统细节**（现在的 `append / size / latestAttempt / read` 就够窄）。

## 5. 给 M3 spec 的具体建议

1. 部署：compose 里 API 挂具名卷做 `AFK_LOG_DIR`（例如 `afk-logs:/var/lib/afk/logs`），和 Postgres 卷放同一块数据盘。
2. 保留策略（服务器）：需求进入终态（合并 / 取消）满 N 天后删除它所有 Run 的日志目录，N 默认 90、可配；删除后 `GET /runs/{id}/logs` 返回「已过期」而不是 404，页面显示为「日志已按保留策略清理」。不按单份日志的修改时间删，以免进行中的长需求丢日志。
3. 磁盘可见性：系统状态面板显示日志目录总大小和剩余空间；剩余空间低于阈值时作为平台故障告警（走事件表 / 飞书）。这和 `docs/platform-evolution.md` 2.3 第 13 条「系统状态面板和磁盘清理成为前提」是同一件事。
4. 保留策略（构建机）：worker 启动时和每天一次清理 `sandbox-logs` 里超过 N 天（建议 14）的目录，和现有的 `pruneSnapshots` 放在一起；这份原始日志未脱敏，**不上传**。
5. 备份：日志不进 Postgres 备份；是否备份日志卷由运维决定，丢了只影响历史排障，不影响状态。
6. 文档：把 `docs/design.md`（存储一行、「服务器上换 MinIO」、M3 架构图里的 MinIO 节点）和 `packages/api/src/logs/log-store.ts` 顶部注释里「M3 swaps the store for MinIO」改成上面的结论。
7. 现有数据搬迁（地图「Not yet specified」里那条）：如果要把 Mac 上的历史搬到服务器，日志就是拷一个目录（十几 MiB），注意 instance id 目录名要和新库对应。
