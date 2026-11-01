# GitHub App 开出的 PR 之后还能不能改描述和评论

> 调研票：xxh171015/afk-platform#129（地图 #125）。调研日期：2026-11-01。
> 只做了官方文档和本仓库源码调查，没有用现有 App 对试点仓库发过写请求。标「**未确认，需实测**」的项要在接适配器时用 installation token 打一次。
> 不做决定：验收包写进 PR 描述还是评论，留给 [#133](https://github.com/xxh171015/afk-platform/issues/133)。

## 结论

现有 GitHub App 的 **Pull requests 写**已经覆盖「开出之后改描述」：`PATCH /repos/{owner}/{repo}/pulls/{pull_number}` 只要这一项，不必 Issues，也不必 Contents。请求体只带 `body` 时，draft / ready 不会变；人在 GitHub 上改过的描述会被整段盖掉。GitHub REST 对这条 PATCH **不支持** If-Match / If-Unmodified-Since。

会话评论（Conversation 页，不是 diff 上的 review comment）走 Issues 评论接口。官方权限表把 `POST/PATCH .../issues/.../comments` 同时列在 Issues 写和 Pull requests 写下，说明「至少一套」即可。本 App 没有 Issues 权限，按文档应靠已有的 Pull requests 写在 **PR** 上发评、改自己的评。反向组合（有 Issues 写、只有 Pull requests 读）在别人的实测里对 PR 评会 403，所以 PR 写才是这条路真正要用的那一套。

置顶评论是另一条路，**走不通**：GraphQL `PinIssueCommentInput` 写明「Comment pinning is not supported on Pull Requests」；REST 置顶接口只列在 Issues 写下（Additional permissions 为否，Pull requests 表里根本没有这一行）；changelog 也只宣布了 Issue。当前 App 也没有 Issues 权限，换 installation token 时要不到。

平台今天并不改已开 PR 的描述，也不发评：适配器只有开 / 读 / 关 / 转 ready / 删分支；验收包写在库里，开 PR 时 body 只是一段 spec 标题加票列表。

## 来源

| 编号 | 来源 | 取得日期 / 版本 |
| --- | --- | --- |
| [D-update-pr] | https://docs.github.com/en/rest/pulls/pulls#update-a-pull-request ；GHES 3.17 同页的 Fine-grained access tokens 框 | 2026-11-01 |
| [D-create-pr] | https://docs.github.com/en/rest/pulls/pulls#create-a-pull-request | 2026-11-01 |
| [D-issue-comments] | https://docs.github.com/en/rest/issues/comments （含 Create / Update / Pin） | 2026-11-01 |
| [D-issue-comments-ghes] | https://docs.github.com/en/enterprise-server@3.12/rest/issues/comments 的 Fine-grained access tokens 框（github.com 页把这块渲掉了，GHES 同源 OpenAPI） | 2026-11-01 |
| [D-review-comments] | https://docs.github.com/en/rest/pulls/comments ；GHES 3.17 同页的 Fine-grained 框 | 2026-11-01 |
| [D-working-comments] | https://docs.github.com/en/rest/guides/working-with-comments | 2026-11-01 |
| [D-app-perms] | https://docs.github.com/en/rest/authentication/permissions-required-for-github-apps | 2026-11-01 |
| [D-choose-perms] | https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app | 2026-11-01 |
| [D-install-token] | https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app ；https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app | 2026-11-01 |
| [D-conditional] | https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#use-conditional-requests | 2026-11-01 |
| [D-gql-pin] | https://docs.github.com/en/graphql/reference/issues#pinissuecommentinput | 2026-11-01 |
| [D-gql-comment] | https://docs.github.com/en/graphql/reference/issues#addcomment 、`#updateissuecomment` 、`#commentcannotupdatereason` | 2026-11-01 |
| [CL-pin] | https://github.blog/changelog/2026-02-05-pinned-comments-on-github-issues/ | 2026-11-01 |
| [GH-6994] | https://github.com/github/rest-api-description/issues/6994 | 开于文档调查时已存在 |
| [REPO] | 本仓库 `origin/main` `ca527e1`：`docs/design.md`、`docs/specs/m1-platform.md`、`docs/specs/m2-platform.md`、`packages/host/src/{types,github,github-app}.ts`、`packages/api/src/host/pull-requests.ts`、`packages/api/src/acceptance/pack.ts`、`packages/worker/src/host.ts` | 2026-11-01 |

## 0. 平台今天实际要到的权限和已经会做的事

**事实** [REPO]

设计文档和 M1 spec 的 GitHub App 清单一致，仓库权限是：

- Contents 读写
- Pull requests 读写
- Checks 只读
- Commit statuses 只读
- Metadata 只读（自动）
- **不给** Workflows、Administration、Actions 写、**Issues**、Secrets

`packages/host/src/types.ts` 的 `TokenPermissions` 只能是 `contents | pull_requests | checks | statuses` 的 read/write。换 installation token 时把这一小撮权限和单个仓库名交给 GitHub；GitHub 规定 token **不能**要到 App 登记时没给的权限 [D-install-token]。所以现在代码里连 `issues: "write"` 都写不进去，硬写也会被换 token 那一步拒掉。

适配器 `packages/host/src/github.ts` 实际发出的写操作：

| 动作 | 接口 | 要的权限 |
| --- | --- | --- |
| 开 PR | `POST /repos/.../pulls`（带 `title`、`body`、`draft`） | `pull_requests: write` + `contents: read` |
| 关 PR | `PATCH /repos/.../pulls/{n}`，body 只有 `{ state: "closed" }` | `pull_requests: write` |
| 转 ready | GraphQL `markPullRequestReadyForReview` | `pull_requests: write` + `contents: write`（试点上缺 Contents 写会 `Resource not accessible by integration`，#92） |
| 删分支 | `DELETE /git/refs/heads/...` | `contents: write` |

没有改 body 的方法，没有发评、改评的方法。`HostAdapter` 也不暴露这些。

开 PR 时写入 GitHub 的描述是 spec 显示编号、标题、该仓库已 done 的票列表，加一句「Opened by the AFK platform…」[`packages/api/src/host/pull-requests.ts` `buildHostTask`]。验收包在最后一个仓库的 PR 记入库之后写入 `acceptance_packs` 表 [`saveAcceptancePack`]，给人看的是 `plat spec show` / 页面。M2 spec 写「仍然只生成一次」。也就是说：**今天验收包不在 GitHub 上**；「随收尾更新」若要做到 GitHub 上，三条路都是新接的。

ETag 只用于 GET 轮询：`If-None-Match`，304 不算配额。PATCH 不带条件头。

App 作者显示为 `<app>[bot]`，和仓库主人不是同一身份 [REPO `docs/design.md`]。

## 1. 改 PR 描述：`pulls.update`

**事实**

- 接口是 `PATCH /repos/{owner}/{repo}/pulls/{pull_number}` [D-update-pr]。可选字段：`title`、`body`、`state`（`open` \| `closed`）、`base`、`maintainer_can_modify`。**没有 `draft`。** 只传 `body` 时，按 REST 惯例其余字段不动。
- GitHub App / 细粒度 token 的权限框写的是必须有 **"Pull requests" repository permissions (write)**，不是「Issues 或 Pull requests 二选一」[D-update-pr GHES Fine-grained 框]。Apps 权限总表里这一行 Additional permissions 为否，只出现在 Pull requests 写下 [D-app-perms]。
- 开 PR 的 `POST /pulls` 同样只要 Pull requests 写；`draft` 只在创建时出现 [D-create-pr]。draft 转 ready 是另一条 GraphQL，平台已经接了，和改描述无关。
- 平台已经在用同一条 PATCH 关 PR（只传 `state`），权限就是 `pull_requests: write` [REPO]。把 `{ body: "…" }` 换成同一条路径、同一套权限，文档上成立。不需要 Contents 写（那是转 ready 才要的）。
- 文档对「谁能开/改 PR」还写了：公开仓库要对 head 有写权限；组织仓库要是组织成员 [D-update-pr]。GitHub App 装在仓库上、用 installation token，走的是 App 权限，不是个人成员身份；平台现在就能开、能关，说明这条对 installation token 是通的。
- 文档没有按 draft / ready / merged 限制改 `body`。`state` 只有 open/closed；已合并的 PR 在 REST 里是 `state=closed` 且 `merged=true`。改描述和转 ready、合并是分开的字段。
- `body` 是整段替换，没有「在某标记之间补一段」的参数。人在网页上改过的字，下一次 PATCH 带新 `body` 就会盖掉。GitHub 自己会留编辑历史（GraphQL `userContentEdits`），API 不提供合并。

**未确认，需实测**

- 已合并、已关闭未合并、conversation locked、仓库 archived 时，只改 `body` 的准确状态码。文档没写禁止，locked/archived 更常挡的是评论。
- 验收包很长时有没有字符上限。REST 页没写 `body` 的最大长度。

## 2. 评论：issue comment、review comment、置顶

GitHub 把 PR 上的评论分成三类 [D-working-comments]：Conversation 上对整个 PR 的评论、Files changed 上对某行的 review comment、对某个 commit 的 commit comment。验收包这类整段文字，对应的是第一类。

### 2.1 Conversation：issue comment

**事实**

- 「Every pull request is an issue, but not every issue is a pull request。」会话评论用 Issues 评论接口，编号就是 PR 号 [D-issue-comments][D-working-comments]。
- 发：`POST /repos/{owner}/{repo}/issues/{issue_number}/comments`，必填 `body`，成功 201 [D-issue-comments]。
- 改：`PATCH /repos/{owner}/{repo}/issues/comments/{comment_id}`，必填 `body`（整段替换），成功 200 [D-issue-comments]。
- GraphQL 对应 `addComment`（subject 可以是 Issue 或 Pull Request）和 `updateIssueComment` [D-gql-comment]。
- 细粒度权限框对 Create 和 Update 都是 **至少一套**：Issues 写 **或** Pull requests 写 [D-issue-comments-ghes]。Apps 总表里这两行在 Issues 写和 Pull requests 写下都出现，且 Additional permissions 为是——含义是「可能不止一种权限组合能打这条，详见该 endpoint 文档」[D-app-perms]。
- 发评会触发通知；发太快会撞 secondary rate limit [D-issue-comments]。
- 改评的身份规则在 GraphQL：`CommentCannotUpdateReason.INSUFFICIENT_ACCESS` = 「You must be the author or have write access to this repository to update this comment.」[D-gql-comment]。作者改自己的评，这一条是满足的。`<app>[bot]` 发的评，作者就是这个 bot。
- 没有「把这条评钉在 PR 时间线上」之外的、REST 提供的置顶手段（见 2.3）。也没有把已有评改成置顶的 Pull requests 权限。

**未确认，需实测**

- 本 App 只有 Pull requests 写、没有 Issues 时，对 **PR 号** 发 `POST .../issues/{n}/comments` 是否 201。文档说「或」即可；[#6994](https://github.com/github/rest-api-description/issues/6994) 测的是反面（Issues 写 + Pull requests 读，对 PR 发评 403，`X-Accepted-GitHub-Permissions` 要求两套都写）。没人在该 issue 里测过「只有 Pull requests 写」。按文档和 6994 的方向，PR 写才是 PR 评真正要的那套，但本 App 没打过。
- installation token 能不能改 **别人** 的评。GraphQL 把「仓库写权限」和作者并列；App 是否算「write access to this repository」没写死。改自己的评不必碰这个问题。
- 人删掉 bot 的评之后 PATCH 是 404 还是别的。文档对 Update 只列了 422。

### 2.2 Files changed：review comment

**事实**

- `POST /repos/{owner}/{repo}/pulls/{pull_number}/comments` 是 **diff 上的** 评，要 `commit_id`、`path`、行号等；文档明确说整段会话评请去 Create an issue comment [D-review-comments]。
- 改：`PATCH /repos/{owner}/{repo}/pulls/comments/{comment_id}`。Create / Update 的细粒度框都是只要 **"Pull requests" write** [D-review-comments]。Apps 总表 Additional permissions 为否 [D-app-perms]。
- 现有 App 权限覆盖这条。它不能当验收包的整页载体：评挂在某次 diff 的某几行上，commit 一变还可能过时。

### 2.3 置顶

**事实**

- 2026-02-05 changelog 标题和正文都是 **GitHub Issues**：从 Issue 评论的 `...` 菜单 Pin，钉到该 Issue 顶部 [CL-pin]。没有提 Pull Request。
- REST：`PUT /repos/{owner}/{repo}/issues/comments/{comment_id}/pin`，说明句是「pin comments **on issues**」，不像 Create 那样写「issues and pull requests」[D-issue-comments]。成功 200；失败有 401/403/404/410/422。
- Apps 权限：置顶 **只** 出现在 Repository permissions for "Issues" 写下，Additional permissions 为否；Pull requests 那张表没有 pin 这一行 [D-app-perms]。现有 App 没有 Issues，换 token 要 `issues: write` 会被拒 [D-install-token]。给 App 加 Issues 写之后，安装方还要批准新权限，旧安装在批准前仍是旧权限 [D-choose-perms]。
- GraphQL `PinIssueCommentInput.issueCommentId`：「The ID of the Issue Comment to pin. **Comment pinning is not supported on Pull Requests.**」[D-gql-pin]。`Issue` 类型有 `pinnedIssueComment`；`PullRequest` 类型没有这个字段。
- 即便将来加了 Issues 写，这条路也钉不了 PR 上的评。这是产品形态上的硬限制，不是漏了权限。

## 3. 权限缺口：没有 Issues 时，PR 的 issue comment 还走不走

**事实**

- 缺口是设计里写明的：Issues 明确「不给」[REPO `docs/design.md`、`docs/specs/m1-platform.md`]。
- 换 token：「The installation access token cannot be granted permissions that the app was not granted.」[D-install-token]。`issues` 在 REST 里的含义是「issues and related comments, assignees, labels, and milestones」；`pull_requests` 是「pull requests and related comments, assignees, labels, milestones, and merges」[D-install-token]。后一句就是 Pull requests 写覆盖「相关评论」的官方定义。
- Create / Update issue comment 的官方组合是 Issues 写 **或** Pull requests 写 [D-issue-comments-ghes]。对象是 **PR** 时，Pull requests 写对得上第二套，也和 `pull_requests` 的「related comments」对得上。
- 对象是普通 Issue 时，没有 Issues 权限发不了评。平台开的是 PR，不需要给普通 Issue 留言。
- 置顶、给 Issue 建票、检测工作流里「开一个 issue」那类动作，才是 Issues 写的范围；和「在自己开的 PR 上留验收包」不是同一条权限。
- 权限不够时 REST 回 403，响应头 `X-Accepted-GitHub-Permissions` 会写出缺哪一项 [D-choose-perms][D-app-perms]。GraphQL 不够权是 401 [D-choose-perms]。
- [#6994](https://github.com/github/rest-api-description/issues/6994) 说明文档「或」在 **PR 评** 上不能读成「Issues 写就够」：Issues 写 + Pull requests 读对 PR 发评 403。本 App 的组合正好相反（有 PR 写、无 Issues），和 6994 的失败组合不是同一件事。

**未确认，需实测**：见 2.1。接适配器时用现有 App 对一张自己开的 PR `POST` 一条评、再 `PATCH` 它，看是 201/200 还是 403。若 403，以 `X-Accepted-GitHub-Permissions` 为准，那才需要改 App 权限并让安装方批准。

## 4. 冲突：人改了描述之后平台再写

**事实**

- `PATCH` 的 `body` 是整份描述的新值，不是补丁 [D-update-pr]。人先改、平台后写，人的字没了；平台先写、人后改，平台的字没了。没有服务端合并。
- 条件请求：ETag / `If-None-Match`、`Last-Modified` / `If-Modified-Since` 用于 **GET**，命中 304 且已认证则不算主配额 [D-conditional]。平台 GET 轮询已经这么做 [REPO]。
- 「Conditional requests for unsafe methods, such as `POST`, `PUT`, `PATCH`, and `DELETE` are not supported unless otherwise noted in the documentation for a specific endpoint.」[D-conditional] Update a pull request、Update an issue comment、Pin 这几页都没有注明 If-Match / If-Unmodified-Since。
- 因此 **没有** 可用的 if-unmodified / etag 乐观锁来挡住「人刚改过」。应用层可以先 GET 再比 `body`（或 `updated_at`）再 PATCH，两个写者之间仍是后写覆盖。
- 评论同理：PATCH comment 也是整段 `body`。人改了 bot 的评，bot 再 PATCH 会盖掉人的改写；bot 再 POST 一条则是新评，旧的还在。
- 转 ready 不会改描述；关 PR 的 PATCH 只传 `state` 时按文档也不会清掉 `body`。冲突只发生在有意写 `body` 的时候。

**未确认，需实测**

- 对 `PATCH /pulls/{n}` 硬塞 `If-Match` 时 GitHub 是忽略还是 412。文档说 unsafe method 的条件请求「除非该页注明，否则不支持」，没写忽略还是报错。不能当锁用。

## 三条路各有什么限制（只列事实）

| 路 | 现有 App 权限够不够 | 接口 | 硬限制 |
| --- | --- | --- | --- |
| 改 PR 描述 | 够（Pull requests 写） | `PATCH /pulls/{n}` `{ body }` | 整段覆盖；draft/ready 无关；无 If-Match；适配器还没接 |
| 会话评论（发一条 / 改自己的） | 文档说够；本 App **未实测** | `POST/PATCH .../issues/.../comments` | 每次 POST 都是新评；PATCH 要记下 `comment_id`；人删了要再 POST；发太快有 secondary limit；不是置顶 |
| 置顶评论 | 不够，而且即加 Issues 也钉不了 PR | `PUT .../issues/comments/{id}/pin`；GraphQL `pinIssueComment` | GraphQL 写明 PR 不支持；REST 只要 Issues 写；changelog 只覆盖 Issue |

Review comment 现有权限也够，但是 diff 评，不是验收包该走的接口。

形态选择（描述 vs 一条可更新的会话评 vs 别的）见 #133。
