# GitLab CE 17.3.1 能给平台用的能力

调研票 #198（地图 #196）。问题：平台接公司的 GitLab CE 17.3.1 需要哪些事实，以及和 `@afk/host`（`packages/host/src/types.ts` 和 GitHub 实现）逐项怎么对上。

**来源**：只用一手资料，都钉在 `v17.3.1-ee` 这个 tag 上（CE 和 EE 共用一套文档和代码，功能的等级看每页的 `Tier:` 行）。

- 文档：`https://gitlab.com/gitlab-org/gitlab/-/blob/v17.3.1-ee/doc/...`，下文写成 `doc/...`
- 源码：同一个 tag 下的 `app/`、`lib/`、`config/`，下文写成 `src:...`

标记：**CE** = Free 等级在自建实例上可用；**Premium** = 要付费等级，公司的 CE 用不了；**开关** = 有 feature flag，写明 17.3.1 的默认值。

## 结论速览

| 题目 | 结论 | 等级 |
| --- | --- | --- |
| bot 身份 | 普通用户 + PAT 可用；PAT 必须有过期日，最长 365 天，可以自己轮换（`/personal_access_tokens/self/rotate`）。项目 / group access token 在自建 Free 上也能用，但要 Maintainer / Owner 去建和轮换。service account 是 Premium | CE |
| 受保护分支 | main 设「允许推送 = No one、允许合并 = Maintainers」，bot（Developer）推不了也合不了。CE 只能按角色设，不能按用户 / group 设 | CE |
| 限制 bot 只推 `agent/*`、`spec/*` | push rules 整个是 Premium；用通配保护分支会挡住 `spec/*` 的强推和 bot 删分支。CE 上只有 Git server hooks（管理员在服务器上放 pre-receive 脚本）能做到 | Premium / 需管理员 |
| MR | 开、关、改描述、读状态、评论都有 REST 接口；**没有 `draft` 参数**，draft / ready 靠标题前缀 `Draft:` 或 `/draft`、`/ready` quick action；重复开会得到 409 | CE |
| 审批和评审 | 可选审批（任何 Developer 都能批）；「必须 N 人审批」「request changes 挡合并」是 Premium，但评审人的 `requested_changes` 状态在 CE 能读到 | CE / 部分 Premium |
| webhook | 项目 webhook 可用，但**配置要 Maintainer**；**group webhook 是 Premium**；系统钩子（管理员配，全实例）只有 push、tag push、MR、repository update，**没有评论和 pipeline** | CE / 部分 Premium |
| webhook 校验和投递 | `X-Gitlab-Token` 是原样发送的共享密钥（不是 HMAC 签名）；**投递失败不重试**；超时 10 秒；自动停用在自建上默认关；**默认不许发往内网地址**，要管理员加白名单 | CE |
| 页面登录 | OAuth 授权码 + PKCE 可用；access token 2 小时，刷新令牌每次轮换；OIDC 的 userinfo 里带 group 路径和按角色分的 group 列表 | CE |
| CLI 登录 | device authorization grant 在 17.3 **默认开启**（beta 类开关 `oauth2_device_grant_flow`，`default_enabled: true`） | CE（管理员可关） |
| 绕过 MR 直推 main | CE 上可以直接**阻止**（受保护分支）。事后检测：push 事件 + `GET /repository/commits/:sha/merge_requests`，这个接口能认出合并提交、squash 提交和 fast-forward 合并 | CE |

## 1. bot 身份

### 普通 bot 用户 + personal access token（CE）

- PAT 是 Free 功能（`doc/user/profile/personal_access_tokens.md`，`Tier: Free, Premium, Ultimate`）。可用的 scope 里平台需要的是 `api`（读写 API）和 `write_repository`（HTTPS 推拉）；`read_user` 用于读自己。
- **PAT 不能限定到某个项目或某些权限**：`api` 能碰到 bot 是成员的所有项目，实际能做什么由角色决定。这一点和 GitHub App 每次按仓库、按权限换一小时令牌（`github-app.ts`）不一样，CE 上没有对应物。
- **bot 不能给自己发更窄的令牌**：`POST /user/personal_access_tokens` 只能发 `k8s_proxy` scope（`doc/api/users.md`「Create a personal access token with limited scopes for the currently authenticated user」）；能发任意 scope 的 `POST /users/:user_id/personal_access_tokens` 只有管理员能调用。
- **有效期**：16.0 起不能建不过期的令牌；不填过期日时自动给 365 天；Free 和 Premium 最长 365 天，自定义上限（「Limit the lifetime of access tokens」）是 Ultimate（`doc/administration/settings/account_and_limit_settings.md`）。17.3 新增的管理员设置「Require expiration dates for new access tokens」默认开（同一页，Free）。
- **到期提醒**：每天检查，提前 7 天和到期当天给令牌主人发邮件（`personal_access_tokens.md`「When personal access tokens expire」）。
- **轮换**：`POST /personal_access_tokens/self/rotate`（16.10 起，用令牌本身鉴权，要 `api` scope）或 `POST /personal_access_tokens/:id/rotate`（16.0 起）。旧令牌立即吊销，新令牌默认一周后过期，可用 `expires_at` 设到一年以内（`doc/api/personal_access_tokens.md`「Rotate a personal access token」）。所以平台可以自己定期轮换 bot 的 PAT，不用人参与；要注意轮换后旧值马上失效，所有持有它的 worker 要同步换。
- Git 推送用 HTTP Basic，用户名随便填非空值、密码是令牌（`project_access_tokens.md`、`group_access_tokens.md` 都这么写）。现在 `pushRef` 用 `x-access-token:<token>` 的 Basic 头，原样能用。

### 项目 access token（CE，自建任何等级）

- 「On self-managed instances of GitLab: With any license tier」（`doc/user/project/settings/project_access_tokens.md`）。
- **要 Maintainer 才能建和管理**（`doc/user/permissions.md`「Manage project access tokens」）；API 默认角色是 Maintainer（`access_level` 默认 40），要显式传 30（Developer）（`doc/api/project_access_tokens.md`）。
- 每个令牌会建一个 bot 用户 `project_<项目id>_bot_<随机串>`，不计席位；成员身份随令牌过期；**吊销后 bot 用户被删、记录挪到 Ghost User**（17.2 加了开关 `retain_resource_access_token_user_after_revoke` 改变这一行为，17.3 默认关）。所以 MR 作者会显示成每个项目各自的 bot，令牌一换作者也换。
- 轮换：`POST /projects/:id/access_tokens/:token_id/rotate`，要一个有权限（Maintainer）的人的 `api` PAT。bot 自己（Developer）换不了。
- 到期前 7 天和 1 天会发「Project and group access token events」webhook（16.11 GA，`doc/user/project/integrations/webhook_events.md`），这一事件只发到项目 / group webhook。

### group access token（CE，自建任何等级）

- 自建 Free 可用，Owner 管理（`doc/user/group/settings/group_access_tokens.md`、`permissions.md`）。bot 用户名 `group_<id>_bot_<随机串>`，其他规则同项目令牌。
- group 可以关掉「Users can create project access tokens and group access tokens in this group」，关掉后已有令牌照常用。

### service account（Premium）

- `doc/api/groups.md`「Service Accounts」是 `Tier: Premium, Ultimate`。CE 上「机器账号」只能是一个普通用户。

**对平台的含义**：地图里定的「一个 bot 用户，各团队 group 的 Developer」在 CE 上是成立的，用 PAT（`api` + `write_repository`）最简单：一个凭据、一个作者、能自己轮换。代价是令牌范围比 GitHub App 大，只能靠「凭据只放在控制面和带 host 能力的 worker 上」和角色来收。项目 / group 令牌的好处是范围限定到项目 / group，但每个项目都要 Maintainer 去建、去换，作者身份分散，不如 bot 用户适合多团队共用。

## 2. 受保护分支与推送规则

### 受保护分支（CE）

来源：`doc/user/project/protected_branches.md`、`doc/api/protected_branches.md`。

- 默认分支默认受保护。受保护分支：git 不能删（Maintainer 以上能在页面或 API 删）；默认不能强推（可以单独打开「Allow force push」）。
- CE 里「允许推送」「允许合并」只能选角色：No one / Developers + Maintainers / Maintainers（API 的 access level 是 0、30、40、60=Admin）。**按用户、按 group 授权是 Premium**（API 的 `allowed_to_push`、`allowed_to_merge`、`allowed_to_unprotect` 写明 Premium）。**group 级的受保护分支是 Premium**（自建）。Code owner 审批是 Premium。
- 16.0 起管理员推受保护分支也要在允许名单里，所以「允许推送 = No one」对所有人生效。
- 一个分支匹配多条规则时取**最宽松**的那条。
- Developer 对未受保护的分支可以推、强推、删（`permissions.md`）。
- 读：受保护分支列表和单条只要 `read_code`（`src:lib/api/protected_branches.rb` 的 `authorize_read_code!`），Developer 能读；改要 Maintainer（`authorize_admin_project`）。`GET /projects/:id/repository/branches/:branch` 返回 `protected`、`developers_can_push`、`developers_can_merge`、`can_push`（当前用户能不能推）（`doc/api/branches.md`）。

**对平台的含义**：

- main：「允许推送 = No one」「允许合并 = Maintainers」，bot 是 Developer，推不了也合不了，这是 CE 上的**硬保证**，比 GitHub 免费个人账号上「平台自己保证 + 事后检测」强。
- **坑**：CE 的合并权限只能按角色给。如果某个团队为了让自己的人（Developer）能合并，把 main 设成「允许合并 = Developers + Maintainers」，**bot 也就能合并**（只是平台代码不调用合并接口）。要硬保证，就得让负责合并的人是 Maintainer。接入团队时平台可以用上面的 branches 接口自检：`can_push` 为 false、`developers_can_merge` 为 false 才算合格，相当于 GitHub 的 `checkAppAccess`。
- **不能靠保护分支把 bot 限在 `agent/*`、`spec/*`**：如果把 `*` 保护起来再放行这两个前缀，`spec/*` 的 `--force-with-lease` 推送就要打开强推，而且受保护分支 Developer 删不了，spec-cleanup 的 `deleteBranch` 会失败。所以这一层继续由 worker 的 `pushRef` 保证。

### 推送规则（Premium）

- `doc/user/project/repository/push_rules.md` 整页 `Tier: Premium, Ultimate`：提交信息格式、分支名格式、检查作者、禁止推送密钥、按文件名禁止、DCO 等，CE 都没有。
- CE 上的替代：**Git server hooks**（`doc/administration/server_hooks.md`，Free、仅自建）。管理员在服务器上用 `gitaly` 命令装 `pre-receive` 脚本，可以写「bot 用户只能推 `agent/*`、`spec/*`」。需要服务器管理员配合，属于运维动作，不是 API。

## 3. MR

来源：`doc/api/merge_requests.md`、`doc/user/project/merge_requests/drafts.md`、`doc/api/notes.md`、`doc/api/merge_request_approvals.md`、`src:lib/api/merge_request_approvals.rb`。都是 CE。

- **开**：`POST /projects/:id/merge_requests`，参数 `source_branch`、`target_branch`、`title`、`description`（最长 1,048,576 字符）、`remove_source_branch`、`squash`、`allow_collaboration`。`:id` 可以是数字或 URL 编码的完整路径（支持子 group，如 `team%2Fsub%2Frepo`）。
- **重复开**：同一源分支已有打开的 MR 时返回 **409**，信息是 `Another open merge request already exists for this source branch: !N`（`src:lib/api/helpers/merge_requests_helpers.rb` 的 `conflict!(errors[:validate_branches])`，文案在 `src:app/models/merge_request.rb`）。之后用 `GET /projects/:id/merge_requests?source_branch=…&state=opened` 找回。
- **draft / ready**：创建和更新接口**都没有 `draft` 参数**。draft 的办法：标题以 `Draft:`、`[Draft]`、`(Draft)` 开头；或在评论里写 `/draft`、`/ready` quick action。转 ready：`PUT` 改标题去掉前缀，或发一条 `/ready` 评论。Developer 就够，不像 GitHub 那样要 contents 写权限。
- **改描述**：`PUT /projects/:id/merge_requests/:iid` 带 `description`。读描述：`GET` 单个 MR 的 `description`。
- **读状态**：单个 MR 返回 `state`（`opened` / `closed` / `locked` / `merged`）、`draft`、`sha`（源分支头）、`merge_commit_sha`（合并前为 null）、`squash_commit_sha`、`merged_at`、`merge_user`、`detailed_merge_status`（`mergeable`、`conflict`、`draft_status`、`ci_must_pass`、`need_rebase` 等）、`head_pipeline`。
- **关**：`PUT …/merge_requests/:iid` 带 `state_event=close`。
- **删分支**：`DELETE /projects/:id/repository/branches/:branch`。
- **评论**：`POST /projects/:id/merge_requests/:iid/notes`，读用 `GET …/notes`（另有 discussions 接口处理讨论串）。
- **CI**：`head_pipeline.status`，取值 `created`、`waiting_for_resource`、`preparing`、`pending`、`running`、`success`、`failed`、`canceled`、`skipped`、`manual`、`scheduled`（`doc/api/pipelines.md`）；或 `GET …/merge_requests/:iid/pipelines`；外部系统写的状态在 `GET /projects/:id/repository/commits/:sha/statuses`。
- **评审**：Free 的审批是可选的，任何 Developer 以上都能批（`doc/user/project/merge_requests/approvals/index.md`）。`merge_request_approvals.md` 整页标 Premium，但其中 `GET …/approvals`、`POST …/approve`、`POST …/unapprove` 在 CE 代码里（`src:lib/api/merge_request_approvals.rb`，不在 `ee/` 下），能读到 `approved_by`。评审人状态用 `GET …/merge_requests/:iid/reviewers`，`state` 取值 `unreviewed`、`reviewed`、`requested_changes`、`approved`、`unapproved`、`review_started`（`src:app/models/concerns/merge_request_reviewer_state.rb`）。「request changes 挡住合并」是 Premium（17.3 去掉开关），CE 上只是一个状态。审批规则（必须 N 人）是 Premium。
- **squash 和合并方式**（Free，`doc/user/project/merge_requests/methods/index.md`、`squash_and_merge.md`）：合并方式有 merge commit、merge commit with semi-linear history、fast-forward；squash 选项 `never`、`always`、`default_on`、`default_off`（项目 API 的 `squash_option`），MR 上的 `squash` 参数会被项目设置覆盖。这些项目设置要 Maintainer 改。

## 4. webhook

来源：`doc/user/project/integrations/webhooks.md`、`webhook_events.md`、`doc/administration/system_hooks.md`、`doc/api/system_hooks.md`、`doc/api/groups.md`「Hooks」、`doc/security/webhooks.md`，以及源码 `src:app/workers/web_hook_worker.rb`、`src:app/services/web_hook_service.rb`、`src:app/models/concerns/web_hooks/auto_disabling.rb`、`src:config/feature_flags/ops/auto_disabling_web_hooks.yml`、`src:config/initializers/1_settings.rb`。

### 三种钩子

| | 项目 webhook | group webhook | 系统钩子 |
| --- | --- | --- | --- |
| 等级 | CE | **Premium** | CE（仅自建） |
| 谁能配 | 项目 **Maintainer** | group Owner | 实例管理员 |
| 事件 | 全部项目事件：push、tag、MR、评论（note）、pipeline、job、部署、发布、access token 到期等 | 同项目，外加 group 成员、子 group 事件 | 系统事件（建项目、加成员、用户等），外加可选的 **push、tag push、MR、repository update**；**没有评论和 pipeline** |
| 发往内网 | **默认禁止**（127.0.0.1、10/8、172.16/12、192.168/16 等），管理员要勾「Allow requests to the local network…」或把地址加进白名单 | 同左 | 默认允许 |

**对平台的含义**：bot 是 Developer，**不能自己给项目配 webhook**。CE 上没有「在 group 上配一次」。可选的组合：

1. 管理员配一个系统钩子（push + MR，所有项目一次搞定），评论和 pipeline 继续轮询；或
2. 每个项目接入时由该项目的 Maintainer 配一个项目 webhook（push、MR、note、pipeline）；平台服务器在内网，**管理员还要把平台地址加进出站白名单**。

两种都要管理员或 Maintainer 动手，这是「接入一个新团队的流程」要写进去的步骤。

### 校验和投递

- **`X-Gitlab-Token`**：在钩子上填的 Secret token 原样放进这个请求头，接收方自己比较（文档原话：endpoint can check the token）。**不是 HMAC 签名**，不保护请求体，所以要走 HTTPS，比较用定时安全的比较。
- 其他请求头：`X-Gitlab-Event`（如 `Push Hook`、`Merge Request Hook`、`Note Hook`、`Pipeline Hook`）、`X-Gitlab-Event-UUID`、`X-Gitlab-Webhook-UUID`（16.2）、`X-Gitlab-Instance`（15.5）、`User-Agent: GitLab/<版本>`。17.0 起可以加最多 20 个自定义头、自定义载荷模板。push 事件可按分支通配或正则过滤。
- **投递失败不重试**：`WebHookWorker` 虽然有 `sidekiq_options retry: 4`，但 `WebHookService#execute` 把 HTTP 错误和超时都 rescue 掉、记一条日志就返回，异常不会抛到 Sidekiq，所以不会重投。人可以在「Recent events」（保留两天，要 Maintainer）里手动「Resend Request」。
- **超时**：`gitlab.yml` 的 `webhook_timeout`，默认 10 秒。文档说超时可能导致同一事件发两次，接收方要能去重。
- **自动停用**：开关 `auto_disabling_web_hooks` 是 ops 类，`default_enabled: false`，注释写明自建默认关，**17.3.1 自建默认不会自动停用**。打开时只作用于项目 webhook（`ENABLED_HOOK_TYPES = %w[ProjectHook]`，group 的在 EE 里加）：连续失败 4 次停用；5xx、超时算临时停用，1 分钟起翻倍到最长 24 小时；4xx 算配置错误，永久停用；发一次测试请求得到 2xx 才恢复。系统钩子不受影响。
- 文档对接收方的要求：尽快回 200/201，处理放进队列；处理过的事件不要回 5xx；只有配置错了才回 4xx。

### 载荷要点（`webhook_events.md`，MR 字段以 `src:lib/gitlab/hook_data/merge_request_builder.rb` 为准）

- **push**（`object_kind: push`）：`before`、`after`、`ref`、`ref_protected`、`checkout_sha`、`user_id` / `user_username`（推送者）、`project.path_with_namespace`、`commits`（最多最新 20 个）、`total_commits_count`。删分支时 `after` 是全 0。**一次推送改了超过 3 个分支时不发**（`push_event_hooks_limit`）。经 MR 合并进 main 也会产生一次 push 事件，推送者是点合并的人。
- **MR**（`object_kind: merge_request`）：`object_attributes.action` 取 `open`、`close`、`reopen`、`update`、`approved`、`unapproved`、`approval`、`unapproval`、`merge`；`object_attributes` 里有 `iid`、`state`、`draft`、`merge_commit_sha`、`source_branch`、`target_branch`、`last_commit`、`detailed_merge_status`、`head_pipeline_id`、`url`；`oldrev` 只在有代码变动时出现；`changes` 给出变了的字段前后值（例如 `draft`）；`user` 是触发的人。源分支有新提交也会触发。
- **评论**（`object_kind: note`）：`object_attributes.noteable_type`（`MergeRequest`、`Commit`、`Issue`、`Snippet`）、`note`、`action`（`create` / `update`，16.11 起），MR 上的评论另带 `merge_request` 对象。
- **pipeline**（`object_kind: pipeline`）：状态变化时触发；`object_attributes` 里有 `status`、`sha`、`ref`、`source`、`name`（16.1 起）；MR pipeline 带 `merge_request` 对象；被封禁用户触发的不处理。

## 5. 登录

来源：`doc/api/oauth2.md`、`doc/integration/oauth_provider.md`、`doc/integration/openid_connect_provider.md`、`doc/api/users.md`、`doc/api/members.md`、`src:config/feature_flags/beta/oauth2_device_grant_flow.yml`。都是 CE。

- **OAuth 应用**三种：用户自己的、group 的（group Owner 建）、实例级（管理员建，可标 trusted 跳过授权确认页）。页面登录用实例级应用最合适，「管理员能配合」正好。
- **授权码 + PKCE**：`/oauth/authorize?...&code_challenge=…&code_challenge_method=S256`，再到 `/oauth/token` 换令牌。access token `expires_in: 7200`（2 小时）；用 refresh token 换新时旧的 access token 和 refresh token 都作废。
- **device authorization grant**：`POST /oauth/authorize_device`（`client_id`、`scope`）拿到 `device_code`、`user_code`、`verification_uri`（`/oauth/device`）、`expires_in: 300`；CLI 显示 code，然后用 `grant_type=urn:ietf:params:oauth:grant-type:device_code` 轮询 `/oauth/token`，按 RFC 8628 处理 `authorization_pending`、`slow_down`、`expired_token`。**版本和开关**：文档写 17.2 加入（开关 `oauth2_device_grant_flow`）、17.3 默认开；17.3.1 源码里开关文件 `milestone: '17.1'`、`type: beta`、`default_enabled: true`（文档的「Supported OAuth 2.0 flows」也写 17.1）。结论：**17.3.1 默认可用**，但它是 beta 类开关，管理员能关掉，接入前要在公司实例上实测一次。
- **读当前用户**：`GET /user`（`read_user` scope 即可）。OIDC（`openid` scope）的 ID token 带 `groups_direct`；userinfo 带 `groups`（直接或经祖先 group 的成员关系，给路径）和 `https://gitlab.org/claims/groups/owner|maintainer|developer`（直接成员、按角色分的 group 名）。
- **group 成员**：`GET /groups/:id/members/all`（含继承和邀请的成员，同一人只给最高的 `access_level`），`GET /groups/:id/members/all/:user_id` 查单人。Free。用登录用户的 `read_api` 令牌或 bot 的令牌都能读（bot 是这些 group 的成员）。

## 6. 能不能检测「绕过 MR 直接推送到 main」

- **CE 上首先能阻止**：main 设「允许推送 = No one」后，任何人（含管理员，16.0 起）都不能直接推。剩下的口子是有 Maintainer 权限的人把保护改松。CE 没有审计事件（`doc/user/compliance/audit_event_types.md` 是 Premium），但平台可以定时读受保护分支配置（`GET /projects/:id/protected_branches`，Developer 就能读）或 branches 接口的 `developers_can_push`，发现被放宽就报警。
- **事后检测**（对应 GitHub 上的 Actions 工作流 + `GET /commits/{sha}/pulls`）：
  1. 收 main 的 push 事件（项目 webhook 或系统钩子都有 push；系统钩子的 push 载荷不带 `commits` 列表，但有 `before` / `after`）。推送者是 bot 直接报警。
  2. 对 `after` 调 `GET /projects/:id/repository/commits/:sha/merge_requests`。源码里这个接口走 `MergeRequestsFinder` 的 `commit_sha` 过滤，即 `by_related_commit_sha`：同时匹配 MR 最新 diff 里的提交、`squash_commit_sha`、`merge_commit_sha`、`merged_commit_sha`（fast-forward 合并记在这里）（`src:app/models/merge_request.rb`、`src:app/finders/merge_requests_finder.rb`）。所以三种合并方式都认得出来。
  3. 要求结果里有 `state = merged`、`target_branch = main` 的 MR；只匹配到打开的 MR（有人把 MR 里的提交直接推上 main）也算绕过。
  4. webhook 不重试，一次推送超过 3 个分支时也不发 push 事件，所以要有兜底：定时比对 main 的头和上次见过的头，或读 `GET /projects/:id/events?action=pushed`（Free，`doc/api/events.md`）。
- 和 GitHub 相比，这套检测在平台里做，不占 CI 分钟，也不依赖「bot 改不了工作流文件」这个前提。

## 7. 与 `@afk/host` 逐项对照

| `@afk/host` 现有的 | GitHub 实现 | GitLab CE 17.3 对应 | 差异和缺口 |
| --- | --- | --- | --- |
| `RepoRef { owner, name }`、`parseRepoUrl` | `owner/name` | 项目完整路径，可以有多层子 group（`team/sub/repo`），API 用数字 id 或 URL 编码的路径 | **缺口**：`parseRepoUrl` 的正则只认两段路径，`git@gitlab.x:team/sub/repo.git` 会被拒。要么让 `owner` 装下多段，要么 GitLab 侧改用完整路径 |
| `TokenPermissions`（contents、pull_requests、checks、statuses） | 安装令牌按仓库、按权限换 | 没有对应：PAT 的范围是 scope + 角色，不能每次缩小 | `TokenSource.tokenFor` 在 GitLab 上就是返回同一个 PAT（`types.ts` 注释里已经这么设想），`permissions` 被忽略；类型名是 GitHub 的，接口可以不改 |
| `TokenSource` / `createAppTokenSource` / `loadAppCredentials` | App 私钥换一小时令牌，缓存到过期前 5 分钟 | PAT 一年以内过期，可 `self/rotate` | **新增**：GitLab 的凭据加载（PAT 文件，600 权限）和轮换任务（提前若干天自动 rotate，并让所有持有者换新值）；`~/.afk/secrets/` 下要有 gitlab 一份 |
| `checkAppAccess`（装了没有、权限够不够、setup 文件在不在） | App 安装和权限 | `GET /projects/:id` 看 bot 的 `permissions.project_access` / `group_access`；`GET /repository/branches/main` 看 `can_push`、`developers_can_merge`；`GET /repository/files/:path?ref=` 看 setup 文件 | **新增**：一个 GitLab 版的接入自检，结论里要能说「main 没保护好，bot 能推 / 能合」 |
| `openPullRequest`（重复开返回已有的） | 201；422 `already exists` 后按 head 找 | 201；**409** `Another open merge request already exists…` 后按 `source_branch` + `state=opened` 找 | 错误码和找回的查询不同；`draft: true` 要变成标题前缀 `Draft: ` |
| `PullRequestInfo.number` | PR 号 | MR 的 `iid`（项目内编号），不是全局 `id` | 存 `iid` |
| `PullRequestInfo.state` | `open` / `closed` / `merged` | `opened` / `closed` / `locked` / `merged` | `opened`→`open`，`locked` 当 `open` |
| `PullRequestInfo.draft` | `draft` | `draft` | 一致 |
| `PullRequestInfo.headSha` | `head.sha` | `sha` | 一致 |
| `PullRequestInfo.ci` | check runs + commit status | `head_pipeline.status`（+ 可选 commit statuses） | `success`→success；`failed`、`canceled`→failure；`created`、`pending`、`running`、`preparing`、`waiting_for_resource`、`scheduled`→pending；`manual`、`skipped` 要定规则；无 pipeline→none |
| `PullRequestInfo.review` | 每个评审人最新的 APPROVED / CHANGES_REQUESTED | `GET …/approvals` 的 `approved_by` + `GET …/reviewers` 的 `requested_changes` | CE 能读到，但 `requested_changes` 不挡合并、审批也不是必须的，只能当信息展示 |
| `getPullRequestBody` / `updatePullRequestBody` | GET / PATCH `body` | GET / PUT `description` | 一致 |
| `markReady`（已不是 draft 就不发） | GraphQL mutation，要 contents 写 | PUT 去掉标题前缀，或评论 `/ready` | 更简单；Developer 就够 |
| `closePullRequest`（只关打开的） | PATCH `state=closed` | PUT `state_event=close` | 一致 |
| `deleteBranch`（不存在算 gone） | DELETE ref，404 / 422 | `DELETE /repository/branches/:branch`，不存在是 404 | 分支必须没被保护，否则 Developer 删不了 |
| 推送（`pushRef`，`x-access-token` Basic 头） | 安装令牌 | PAT 作密码，用户名任意非空 | 原样能用；`spec/*` 的强推要求这些分支不受保护 |
| 不调用合并接口（测试保证） | 同 | 同；CE 上还能靠保护分支硬挡 | 若团队把「允许合并」开给 Developers，bot 也能合，仍靠这条测试 |
| 状态同步：`host-sync` 每分钟轮询，ETag 省限额 | 轮询 | webhook（push、MR；note、pipeline 视钩子类型）+ 轮询兜底 | **新增**：webhook 入口（校验 `X-Gitlab-Token`、去重、入队）；webhook 不重试，轮询不能去掉，只是变慢 |
| 「直推 main」事后检测 | 每仓库一个 Actions 工作流 | 平台收 push 事件 + `commits/:sha/merge_requests` | **新增**，见第 6 节 |
| 评论（返工、回复） | 现在没有 | notes API + note 事件 | 返工在地图范围外；只需要知道 CE 都支持 |
| 登录 | 现在没有 | OAuth（页面：授权码 + PKCE；CLI：device grant）+ `GET /user` + group 成员 | **新增**，不属于 `HostAdapter`，是控制面的身份部分 |

## 8. 要在公司实例上实测的

文档和源码说得通，但下面几项依赖实例的配置，原型或环境摸底时要真试一次：

1. device grant 在公司实例上没被管理员关掉；OAuth 应用设成非机密（public）时 PKCE 和 device grant 是否都能走。
2. 平台服务器的地址能不能进「出站白名单」，项目 webhook 能否送达。
3. 管理员是否改过默认分支保护、令牌最长有效期、「Require expiration dates」。
4. fast-forward 合并时 `commits/:sha/merge_requests` 确实能返回已合并的 MR（源码看是走 `merged_commit_sha`）。
5. 实例的 API 限流设置（本次没查）。
