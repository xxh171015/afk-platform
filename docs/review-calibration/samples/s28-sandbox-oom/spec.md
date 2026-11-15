# M4：飞书通知、容器加固、追溯与 bug 定位

# M4：飞书通知、容器加固、追溯与 bug 定位

2026-11-11。依据 grill-with-docs 达成的共同理解、设计方案、M4 计划、GLOSSARY、ADR 0008（事件由触发器写）和 ADR 0009（通知和 SSE 读事件表）。术语以 GLOSSARY 为准。控制面和 worker 仍在用户 Mac 本机。

## Problem Statement

M3 让两个项目的需求在这台 Mac 上跑完了，但人一离开键盘就收不到要回来处理的事：通知只有本机横幅，磁盘告警、agent 暂停、令牌到期还各自偷偷发，和事件对不上，重启还会重发。沙箱容器没有内存和权限上限，OOM 看不出是平台的问题。从一行报错回到「当初那张票、那个需求」只能手翻 trailer，也没有把 bug 报告交给平台去定位、预填一份 bug 需求草稿的路。

## Solution

M4 继续只在 Mac 上把这三件事做完，迁服务器、登录、多 worker、出网白名单放到以后。

- **通知改读事件**：状态变化、人的操作、系统状况都是 Event。派发器按事件游标发 Notification，同一条给 macOS 和飞书两个渠道；同一 Spec 30 秒合成一条，重启不重发。飞书按项目发到群。页面 SSE 也由事件推出要刷新的编号。
- **容器加固**：所有 Sandcastle 沙箱（票的流水线、需求收尾、联调 e2e / Diagnosis、update-branch、Locate、`plat repo check`）加上 cap-drop、内存和进程上限。OOM 立刻记成 `sandbox-oom`，失败来源是平台。联调 compose 服务不加固。不改沙箱镜像。
- **追溯和 bug 回流**：Link 记下改写后的 commit 与 Ticket、Spec、PR。`plat context --files` 从人的 checkout 给出指针。`plat bug` 先建一份 bug 草稿再跑 Locate；找到原 Spec 就填上指针，找不到进待处理。之后人照常规划，走同一条流水线，不自动拆票、不自动开工。

人出现的时机仍是规划、处理待处理、最后合并；人离开这台 Mac 时，项目群里的飞书卡片能把人叫回来。

## User Stories

通知与事件

1. As a 开发者, I want 票卡住、收尾卡住、需求暂停、可以验收、PR/MR 转 ready、需求合并、其它待处理这些事发成 Notification, so that 我不用一直盯页面。
2. As a 开发者, I want 同一条 Notification 同时出现在 macOS 横幅和飞书群, so that 我在不在这台 Mac 前都能看到。
3. As a 开发者, I want 飞书渠道关着或这个项目没配群时，还开着的渠道照发, so that 配飞书之前本机通知仍然可用。
4. As a 开发者, I want 同一需求 30 秒内发生的多件事合成一条再发, so that 一次收尾不会刷一串卡片。
5. As a 开发者, I want 合成时标题取最急的那条、正文列出窗口里每一条, so that 我不会漏掉卡住。
6. As a 开发者, I want API 重启后已经发过的事件不再发, so that 重启不是一次重放。
7. As a 开发者, I want 没有所属需求的系统状况各自按事件发、不和需求窗口合并, so that 磁盘告警不会被某张票的完成吞掉。
8. As a 开发者, I want 磁盘跌破阈值、agent 因提供方拒绝而暂停、GitLab 令牌即将到期，也记成 Event 再走同一套派发, so that 没有第三条旁路通知。
9. As a 开发者, I want 这三类系统状况在同一状态下只记一次，恢复后再跌破才再记, so that 每分钟巡检不会刷事件。
10. As a 开发者, I want 飞书卡片带需求或票的显示编号、一句原因、打开控制塔的按钮，并标明「本机链接」, so that 同群里打不开这台机器的人至少知道编号。
11. As a 开发者, I want 控制塔页面的链接就是这台 Mac 的地址, so that M4 不另做公网入口。
12. As a 运维, I want 飞书应用凭据只放在本机密钥文件里（仅自己可读），发送前按需取租户令牌并缓存到过期前, so that 密钥不进库、不进 git。
13. As a 运维, I want 密钥文件不存在时飞书渠道关闭、页面状态区提示，API 照常启动, so that 没配飞书也能跑平台。
14. As a 开发者, I want 用 `plat project edit` 给项目配飞书群 chat_id, so that 改群号和改别的项目设置一样走 CLI。
15. As a 开发者, I want 项目页上能改飞书群号、看到渠道是否因缺密钥关闭、按一下测试发送, so that 不用只靠 CLI。
16. As a 开发者, I want 项目设置页只做飞书这件事, so that 模型、并发、保护路径仍只走 `plat project edit`，M4 不摊成完整设置后台。
17. As a 运维, I want 没配项目群的通知可以发到可选的平台默认群, so that 系统状况和忘了配群的项目还有去处。
18. As a 运维, I want 默认群也可以不配，此时这些通知只走 macOS, so that 缺环境变量不挡住 API。
19. As a 开发者, I want `plat feishu test --project` 往该项目的群（否则默认群）发一条测试卡片, so that 接入时能立刻知道群号对不对。
20. As a 开发者, I want 飞书发送按平台限频排队，失败退避重试几次后只记日志、不堵住后面的派发, so that 飞书抖动不会卡住控制面。
21. As a 开发者, I want 同一条合成通知用窗口内第一条事件的 id 做飞书去重键, so that 重试不会在群里出现两张相同的卡片。
22. As a 开发者, I want 打开控制塔时页面随事件刷新该刷新的需求、票、运行和工作台, so that 我不用手动刷新。
23. As a 开发者, I want 没有所属需求的系统状况也刷新工作台和待处理, so that 磁盘横幅和暂停条会自己出现。
24. As a 开发者, I want 关掉的标签页再打开时自己把数据拉回来，SSE 不补历史, so that 服务器不必为每个浏览器记游标。

时间线

25. As a 开发者, I want 有事件的需求时间线按事件顺序展示状态变化和我做过的操作（含暂停/恢复、进出 blocked）, so that 我看到的是历史，不是「此刻还卡着」的快照。
26. As a 开发者, I want PR/MR 的开、转 ready、合并和验收包仍按领域表出现在时间线上, so that 托管同步来的节点不丢。
27. As a 开发者, I want 作业排队、领取、完成这些碎事件不上时间线, so that 时间线还能读。
28. As a 开发者, I want 一条事件都没有的老需求仍用原来的拼法，并在页面上注明, so that 事件表上线前的记录还能看。

容器加固

29. As a 开发者, I want 票的 implement、门禁、review、各种 fix、merge、e2e、Diagnosis 跑在加固过的沙箱里, so that 一条失控的命令不能吃光这台 Mac。
30. As a 开发者, I want 需求收尾的 overall review、fix、开 PR 前的 e2e 也用同一套加固, so that 收尾路径不是第二个未加固入口。
31. As a 开发者, I want update-branch、Locate、`plat repo check` 的沙箱同样加固, so that 所有 Sandcastle 容器一个标准。
32. As a 开发者, I want 联调环境的 compose 服务维持现状、不套这套加固, so that Postgres 和前端容器还能按现在的方式起来。
33. As a 开发者, I want 沙箱默认内存、进程数、CPU、共享内存按这台 Mac Docker VM 大约 7.8 GiB 来定，并能用 worker 环境变量改, so that 两个槽位加一次联调还能转，以后也能调。
34. As a 开发者, I want 沙箱丢掉全部 Linux capabilities、不能再提权、有 init 收僵尸进程，并打上运行编号和 agent/gate 标签, so that 残留容器清得掉、权限面最小。
35. As a 开发者, I want 现有的挂载、环境变量、联调网络、容器用户和 HOME 保持不变, so that agent 和门禁还能读到上下文和 skills。
36. As a 开发者, I want 容器 OOM 时票或收尾立刻以 `sandbox-oom` 卡住，失败来源是平台，并提示调大内存, so that 不会拿同一上限默默重试三次。
37. As a 开发者, I want Locate 遇到 OOM 也用 `sandbox-oom`（平台问题），而不是「定位不到」, so that 我去调内存而不是改报告。
38. As a 开发者, I want 清理残留沙箱时按标签找，找不到再按挂载路径兜底, so that 死掉的 worker 留下的容器不会占着槽位。
39. As a 开发者, I want M4 不改沙箱镜像和它的保护路径, so that Chromium 仍用镜像里现有的无沙箱方式；若加固导致 e2e 起不来，停下来由人决定收哪些旗，而不是改 Dockerfile。

追溯

40. As a 开发者, I want 票合进集成分支时，这次运行改写后的每个 commit 记一条 kind 为 ticket 的 Link, so that 从 SHA 能回到票和需求。
41. As a 开发者, I want 收尾修复那种没有 Ticket trailer 的提交仍然记下 Spec 和 Run，Ticket 留空, so that 总览修复也能追溯。
42. As a 开发者, I want 不把 Sandcastle 改写前的 SHA 记进 Link, so that 库里的 SHA 和 git log 里看到的是同一个。
43. As a 开发者, I want PR/MR 第一次被看到已合并时，适配器带回合并或 squash 的 SHA，再排作业在默认分支上读 trailer 写成 kind 为 pr 的 Link, so that 合进默认分支之后也能从合并提交回去。
44. As a 开发者, I want squash 合并只追溯到 Spec，并以 PR/MR 正文里的 Spec 编号为准, so that 压成一个提交时不假装能回到某一张票。
45. As a 开发者, I want 这段读 trailer 的工作是单独的作业，而不是塞进每分钟的托管同步, so that 同步仍只谈话托管 API，clone 默认分支是另一件事。
46. As a 开发者, I want `plat context --files` 在我的 checkout 里对已提交的行做 blame，补上 Link 和指针（需求、票、PR/MR、实现决策、不做的范围、相关 ADR），不复制正文, so that 从一行代码能确定地回到当时的决策。
47. As a 开发者, I want 未提交或还没入库的行被跳过、不报错, so that 工作区脏的时候命令仍然有用。
48. As a 开发者, I want 当前 checkout 的 remote 能对上项目里的仓库时不必写 `--repo`, so that 常见用法最短。
49. As a 开发者, I want 对不上时再要求 `--repo`, so that 不会把文件安到错误的仓库上。
50. As a 开发者, I want `--json` 给出机器可读的同一份指针, so that 别的工具能接着用。
51. As a 开发者, I want 需求页上看到这个需求的 commit、票、PR/MR，以及指向它的 bug 需求, so that 不在 checkout 里也能看索引。
52. As a 开发者, I want 从文件出发的查询只走 `plat context`，网页不做 blame, so that API 不必持有我的工作区。

bug 需求与定位

53. As a 开发者, I want `plat spec create --type bug --source S-n` 把原 Spec 写下, so that 手建的 bug 需求也指得回去。
54. As a 开发者, I want `--source` 可以省略, so that 外来的、还对不上原需求的 bug 也能建。
55. As a 开发者, I want 只有 bug 类型能填原 Spec，且必须同一项目、不能指向自己, so that 不会把 feature 错当成回流。
56. As a 开发者, I want 原 Spec 可以是 feature、bug 或 improvement, so that 可以在上一个 bug 上再开 bug。
57. As a 开发者, I want 需求详情显示「原需求」，原需求页列出指向它的 bug, so that 回流看得见。
58. As a 开发者, I want `plat bug --project --file` 读一份报错/堆栈/现象，立刻建一份 bug 草稿（正文先放报告）, so that 定位这次运行有需求可挂、有日志可看。
59. As a 开发者, I want 草稿建好后排一次 Locate：只读 agent，不改代码、不提交, so that 它不会在默认分支上动手。
60. As a 开发者, I want Locate 不是票流水线里的一个 Stage，也不建修复票, so that 它不会和联调的 Diagnosis 混成一件事。
61. As a 开发者, I want 一次报告一个作业，项目里每个仓库的默认分支进同一个沙箱（其余只读参考）, so that agent 看得到前后端，输出里只点名一个仓库。
62. As a 开发者, I want agent 给出是否找到、仓库名、文件、证据和复现步骤，然后 worker 在点名的仓库上 blame 并解析 trailer, so that 原票和原需求来自 git，不靠模型编造编号。
63. As a 开发者, I want 定位成功时补上原 Spec 和 `plat context` 那样的指针, so that 我接着 grill 时上下文已经在草稿里。
64. As a 开发者, I want 定位不到时草稿留在 draft，进待处理，原因码 `bug-unlocated`，失败来源是需求本身, so that 我去补报告或手填原 Spec。
65. As a 开发者, I want 待处理里定位失败是一种挂在该草稿上的事项，不是票的 blocked, so that 没有票的草稿也排得进队列。
66. As a 开发者, I want 可以重试 Locate，或自己补原 Spec 之后照常 grill → to-tickets → confirm, so that 平台不替我拆票、不替我开工。
67. As a 开发者, I want 定位成功和失败各是一种 Notification, so that 我不用刷新待处理才知道草稿好了。
68. As a 开发者, I want Diagnosis 和修复票仍然只服务于联调 e2e 失败, so that 线上报错不会被当成联调修复票自动插进正在跑的需求。

## Implementation Decisions

### 事件驱动的通知和 SSE（ADR 0009）

- 写事件的触发器在事务提交后通知监听者，payload 是新行的 id。API 维持一条监听连接，按 id 游标读新事件；断线后从游标接着读。
- 通知派发器消费同一条事件流。已派发的游标存在实例行上（`last_notified_event_id`）。进程重启从该游标继续，不重发。
- SSE 仍是活流：每条事件推出要失效的 Spec / Ticket / Run 编号；没有这些编号时发空负载，页面照旧刷新工作台和待处理。SSE 不存游标、不补历史；标签页重连后由页面自己拉数据。
- 路由不再手动发布失效；快照前后对比那条派发路径退役。现有七种通知文案复用，事件到这七种的映射与今天快照边沿的条件一致。
- 另增两种通知：`locate-succeeded`、`locate-failed`。
- 同一 Spec 从窗口内第一条事件起算 30 秒固定窗口，到点合成一条交给各渠道，不因窗口内又来事件而顺延。合成标题按优先级：票卡住 > 收尾卡住 > 需求暂停 > 定位失败 > 其它待处理 > PR/MR 转 ready > 可以验收 > 定位成功 > 需求已合并。正文列出窗口内每一条。飞书去重键用窗口内第一条事件的 id。
- 没有 Spec 的系统状况不进窗口，按事件 id 各发各的。
- 渠道接口带上 Notification、可选的项目 id、事件 id。macOS 渠道保留。进程启动时按配置组装还开着的渠道。

### 系统状况也是 Event

- Event 的类型增加 `system`。磁盘告警、agent 暂停、令牌到期改为在边沿显式插入事件（和人的操作一样，不靠状态触发器），再走派发器。
- 现有的边沿旗标留下来，只回答「该不该再插一条」：跌破阈值、第一次暂停、某个到期日各一条；恢复后再跌破才再插。旗标不再直接调用渠道。

### 飞书渠道

- 应用凭据：`~/.afk/secrets/feishu/app.json`，权限 600，字段 `app_id` / `app_secret`。每次发送前按需取租户令牌，缓存到过期前。文件缺失或权限过宽则渠道关闭，页面状态区提示；不挡 API 启动。
- 发送：飞书 IM 消息接口，`receive_id_type=chat_id`。消息卡片含标题、显示编号、原因、打开控制塔的按钮（`AFK_PAGE_URL`，默认本机页面地址），按钮文案标明「本机链接」。
- 限频按 5 QPS 排队；失败退避重试 3 次后记日志，不阻塞后续派发。
- 项目增加 `feishu_chat_id`。写入走现有的项目编辑（CLI `plat project edit --feishu-chat`），不是一条新的 `set` 子命令。
- 平台级默认群来自环境变量 `AFK_FEISHU_DEFAULT_CHAT`，可选。未配项目群、以及没有项目的系统状况走默认群；默认群也没有则只走还开着的渠道。
- 测试发送：项目页按钮，以及 `plat feishu test --project <id>`。真发飞书，仅本机；自动测试打假 HTTP。
- 控制塔项目页只加飞书群号、测试发送、渠道是否关闭。其它项目设置仍只走 CLI。

### 时间线读事件表

- 该需求至少有一条事件：状态变化和人的操作从事件表按时间排。收录的类型是 spec / ticket / planning / finalization / final-e2e / action，以及带 spec id 的 system。作业事件和托管同步的每一次轮询细节不上时间线。
- PR/MR 开、转 ready、合并，以及验收包，仍从领域表来。
- 一条事件都没有的需求沿用现在从领域表拼的办法，页面注明。
- 前端时间线种类表与后端对齐；人的操作（含恢复）都要出现。

### 容器加固

- 在现有 Sandcastle 入口里自写 bind-mount 的 docker provider，不 fork 上游。`docker run` 增加：丢掉全部 capabilities、禁止再提权、`--init`、pids / memory（memory-swap 与 memory 同值）/ cpus / shm-size、标签 `afk.run=<R-n>` 与 `afk.kind=agent|gate`。现有 mounts、env、network、容器用户、HOME 不变。
- 默认值按 Mac Docker VM 约 7.8 GiB 定，可用 worker 环境变量改：内存 3g、pids 4096、cpus 2、shm 1g。原型实测后只调这些默认值，不改镜像。
- 自写 exec（逐行流，idle 超时依赖它）、copy in/out、close（stop + rm）。docker CLI 做成可注入函数，与今天清理残留容器的缝同一形状。
- 覆盖所有经 Sandcastle 起来的容器：票流水线、需求收尾、开 PR 前的 e2e、Diagnosis、update-branch、Locate、`plat repo check`。联调 compose 服务不套这些参数。
- OOM：exec 非零或 close 前 inspect `OOMKilled`。新原因码 `sandbox-oom`，失败来源 = 平台，加入票和收尾的原因码表。一旦认定立刻停下，不把同一内存上限再试到第三次作业失败。
- 残留清理改用标签过滤，挂载路径兜底保留。
- 不改 `.sandcastle/**`。演练时若 cap-drop 导致 Chromium e2e 起不来，停下来等人，不擅自改镜像。

### Link 与 `plat context`

- 新表 `links`：仓库、commit SHA、Spec、Ticket（可空）、Run、PR（可空）、kind。kind 只有 `ticket` 和 `pr`。
- `ticket`：票（或收尾修复）合进集成分支时，从该次运行记下的、trailer 改写后的 SHA 写。没有 Ticket trailer 时 ticket 为空，仍有 Spec 和 Run。
- `pr`：托管同步第一次看到 PR/MR 已合并，适配器必须给出 merge 或 squash SHA（GitHub、GitLab 都加）。然后排作业 `index-pr-links`：worker 在默认分支槽位里走这次合并带进来的提交，正则读 trailer 写入。squash 只到 Spec 级，以 PR/MR 正文的 `Spec:` 为准。不把这段塞进 host-sync。
- `plat context --files`：在人的 checkout 里 `git blame --porcelain` 取 SHA，跳过未提交行；共享的 trailer 解析放在共用包。再请求新的追溯接口，用 Link 补全，返回指针（需求、票、PR/MR 链接、实现决策和不做的范围、相关 ADR 的路径），不复制正文。`--json` 机器输出。`--repo` 可省：用当前 remote URL 对项目里的仓库；对不上再要求该参数。
- 需求页追溯区读 Link：这个需求的 commit / 票 / PR，以及 `source_spec_id` 指向它的 bug 需求。网页不做 blame。

### Locate 与 bug 需求

- `createSpec` 为 bug 类型写入可选的 `source_spec_id`。CHECK：只有 bug 可非空；必须同一项目；不能指向自己。目标可以是任一 Spec 类型。M4 不做全链环检测。
- CLI：`plat spec create --type bug --source S-n`，`--source` 可选。需求页显示原需求；原需求页列出它的 bug。
- `plat bug --project --file`：立即建 `type=bug` 的草稿（正文先放报告，原 Spec 先空），再排 `type=agent-run`、stage 为 `locate-bug` 的作业。Locate **不**加入票流水线的 Stage 列表，不建 Ticket，不用票类型 `system`。Run 挂在这份草稿上，ticket 为空。
- 一次 `plat bug` 一个作业。worker 把该项目各仓库默认分支 checkout 进槽位，一个沙箱挂进去（规划仓库或第一个仓库当工作区，其余只读参考）。不启联调 compose。结构化输出：`{ result, repo, files, evidence, reproduction }`，`repo` 只能点名一个仓库。随后只在该仓库上 blame + 解析 trailer。
- 成功：补上 `source_spec_id` 和指针。失败（找不到原需求）：草稿保持 draft，待处理新种类 `locate`，原因码 `bug-unlocated`，失败来源 = 需求本身。OOM / 作业基础设施失败用 `sandbox-oom`，失败来源 = 平台，不算 unlocated。
- 人可以重试 Locate，或手填 `--source` 后 grill → to-tickets → confirm。不自动拆票、不自动开工。
- 定位成功/失败走上面的通知。

## Testing Decisions

只测对外行为（HTTP、CLI、导出的纯函数），不测私有方法和内部调用次数。门禁按仓库根目录的约定：真 Postgres，不 mock 本包模块；系统边界（飞书 HTTP、代码托管 HTTP、docker CLI、agent 运行器、时间）才用假对象。改了原因码对应表要连同 SQL 函数一起测两边一致。加固必须在**票的门禁**和**收尾 / e2e**两条路上都成立（两条路都开 Sandcastle 沙箱）；`plat repo check` 走同一套 provider，用同一组 docker run 断言覆盖。

测试缝（seams）三层，尽量用最高的一层；新缝只加在系统边界，不在模块内部再拆：

1. **HTTP + 真 Postgres（控制面缝）**：事件 → 七种通知及两种定位通知的映射；30 秒固定窗口合成与优先级；游标重启不重发；系统状况插事件且旗标不直接发通知；SSE 由事件推出失效编号（无 spec 时工作台仍刷新）；时间线有事件出历史、零事件走旧拼法、作业事件不上时间线；Link 在集成合并和 `index-pr-links` 写入（ticket 可空、squash 到 Spec）；追溯接口只返回指针；bug 的 `source_spec_id` 约束；Locate 成功补草稿 / 失败进待处理 `locate`；`sandbox-oom` 立即卡住且来源是平台。先照现有通知、事件、诊断建修复票、等待队列那几组 API 测试的形状写。
2. **pipeline / worker 缝（可注入的 docker、假飞书 HTTP、假 GitHub/GitLab HTTP）**：自有 provider 的 `docker run` 参数（假 docker）；OOMKilled 映射到 `sandbox-oom`；trailer 解析和 blame；适配器返回 merge/squash SHA；飞书客户端取令牌、缓存、限频、重试、去重键。先照残留沙箱清理、GitLab 适配器、令牌文件权限那些测试的注入缝来写。
3. **CLI 缝**：`plat spec create --source`、`plat project edit --feishu-chat`、`plat feishu test`、`plat bug`、`plat context --files`（未提交行跳过、能认出仓库可省 `--repo`、`--json`）。走现有 CLI 对 HTTP 的集成测法。

自动化不打真飞书、不打真 Docker daemon（门禁用假 docker）。Mac 实测见 Further Notes，不进 CI。

## Out of Scope

迁公司服务器、多 worker（能力标签 / 协议版本 / `plat drain`）、页面登录和 CLI / worker 凭证、沙箱出网白名单、GitLab bot 账号与 PAT 自动轮换、webhook、飞书卡片按钮直接操作（长连接）、按人发私信、GLOSSARY / ADR / 契约的 pgvector 索引、接线上监控、自动拆 bug 票、完整的项目设置后台、改 `.sandcastle/**`、跨 Spec 依赖边、PR 评论返工。

## Further Notes

### 建议的实现顺序（供 to-tickets 参考）

1. 事件推送：触发器通知 + API 监听 + 游标；SSE 改由事件喂。
2. 通知派发器从事件出发（合并、去重、系统状况），macOS 渠道接上。依赖 1。
3. 飞书渠道 + 项目群 + 默认群 + 测试发送。依赖 2。
4. 时间线读事件表。依赖 1。
5. 加固 provider（可注入 docker、标签清理）。覆盖票门禁和收尾/e2e。
6. `sandbox-oom` 原因码与 OOM 检测。依赖 5。
7. Link 表：集成合并写 `ticket`；适配器返回合并 SHA；`index-pr-links`。
8. `plat context --files` 与追溯接口。依赖 7。
9. bug 需求：`--source`、原需求关联、需求页追溯区。依赖 8。
10. Locate 与 `plat bug`，补草稿或进待处理。依赖 8、9。
11. 演练（人来跑）。12. 验收（人来跑）。

1、5、7 可并行起步。

### 验收需求

在用户 Mac 上 3000 端口的平台（或独立端口/库/`AFK_HOME` 的原型，最后在 3000 演练）：

1. **飞书**：给 `shop-gl` 配真实群 chat_id，制造 blocked 和需求完成；群里收到合成后的卡片，重启 API 不重发；`plat feishu test` 能发通。
2. **加固**：加固下跑试点前后端门禁（含 Postgres、Chromium e2e）和一次真实 Cursor implement；用超内存命令触发 OOM，票或运行看到 `sandbox-oom`。收尾或 e2e 路径至少有一条自动测试证明同一套 `docker run` 参数。
3. **追溯与 bug**：在 `shop-gl`（M3 订单备注需求已合并）上造一份订单备注相关的 bug 报告，`plat bug` → Locate 到后端文件 → 草稿指向该需求；`plat context --files` 在本机 checkout 里给出同样的指针。

人只在规划、处理待处理、合并时出现。不自动拆 bug 票、不自动开工。

### 演练清单（手动，在 Mac 上用真实 Cursor 和真飞书）

- [ ] 密钥文件拿掉：飞书渠道关闭，macOS 仍通知，API 不挂。
- [ ] 同一需求 30 秒内连续 blocked 再完成：群里一条合成卡片，不是两条。
- [ ] 重启 API：已发过的事件不重发；飞书去重键挡住渠道侧重试。
- [ ] 未配项目群、未配默认群：系统状况只走 macOS。
- [ ] 加固下跑 Chromium e2e；若 cap-drop 起不来，记下，不改镜像。
- [ ] OOM：原因码 `sandbox-oom`，来源平台，不会默默重试满三次。
- [ ] `plat context` 对脏工作区：未提交行跳过，已提交行仍给出指针。
- [ ] Locate 失败：草稿进待处理 `locate`，原因 `bug-unlocated`；重试或手填 `--source` 后能继续规划。
- [ ] Locate 时 OOM：待处理是 `sandbox-oom`，不是 unlocated。

### 已知的、没有实测过的

- cap-drop ALL 之后镜像里的 Chromium `--no-sandbox` 是否仍能跑试点 e2e（保护路径，失败由人收旗）。
- 默认 3g/2 CPU 在两个槽位加一次联调时，这台 Mac VM 是否还够；不够只调环境变量默认值。
- 飞书企业自建应用对 chat_id 卡片 `uuid` 去重的实际行为（以本机 `plat feishu test` 和一次重试为准）。

