# 平台怎么用飞书机器人给人发通知

> 调研票：xxh171015/afk-platform#199（地图 #196）。调研日期：2026-11-08。
> 只读了飞书开放平台官方文档（open.feishu.cn）和官方 Node SDK `@larksuiteoapi/node-sdk` 1.76.0 的发布包源码，**没有建过飞书应用，没有真实发过一条消息**。标「**未确认，需实测**」的项要在公司租户里用一个测试应用跑一遍。
> 不做选型：发哪些事件、通知谁、选群机器人还是应用机器人，留给 [#206](https://github.com/xxh171015/afk-platform/issues/206)。

## 结论

1. **自定义机器人（群 webhook）只能发到它所在的那一个群，发不了个人。** 它不需要建应用、不需要管理员审核，拿到 webhook URL 就能 POST；支持签名校验（`timestamp + "\n" + secret` 作 HmacSHA256 的 key，签空串再 Base64）、关键词、IP 白名单；限频单机器人 100 次/分钟、5 次/秒，请求体 ≤ 20 KB；能发消息卡片，按钮能跳 URL，但**不支持回传交互**。卡片里 @ 人要 open_id / user_id——这些只有应用才拿得到。[CB]
2. **要「叫某个人回来」，只能用企业自建应用 + 机器人能力。** 用 `tenant_access_token` 调 `POST /open-apis/im/v1/messages`，`receive_id_type` 可以直接是 `email`（「以用户的真实邮箱来标识用户」）、也可以是 `open_id` / `user_id` / `chat_id`，所以同一个应用既能私信个人、也能发到它所在的团队群。权限 `im:message:send_as_bot`（或 `im:message`）；接收人必须在应用的**可用范围**内；同一用户 5 QPS、同一群（群内机器人共享）5 QPS、整个接口 1000 次/分钟 · 50 次/秒；卡片 ≤ 30 KB；可传 `uuid` 让 1 小时内同一请求只成功一次。[MSG]
3. **GitLab 账号对应飞书用户：按邮箱。** 最省事是发消息时直接 `receive_id_type=email`；要先换 ID（缓存、@ 人用）就调 `POST /open-apis/contact/v3/users/batch_get_id`，一次最多 50 个邮箱 / 手机号，权限 `contact:user.id:readonly`，默认返回 open_id（open_id 是**每个应用各不相同**的）。坑：**必须是飞书通讯录里用户资料的邮箱，飞书「企业邮箱」地址查不到**；应用的通讯录数据权限范围默认等于可用范围，查不到人时先看这个。GitLab 里登记的邮箱和飞书资料里的邮箱是否一致，要拿公司真实账号核实（**未确认，需实测**）。[BGI][DATA]
4. **内网服务器只出站完全够用。** 发消息、换 token、查 ID 都是我方主动 HTTPS 调 `open.feishu.cn`；通知卡片上的按钮用 `open_url` 跳回平台页面，点击时是用户自己的飞书客户端/浏览器打开链接，飞书服务器不访问平台，所以内网地址的链接只要用户电脑在内网就能打开。将来要在卡片上「点按钮直接操作」（回传交互 `card.action.trigger`），也不用开入站：企业自建应用可用**长连接**（SDK 主动建 WebSocket，「无需提供公网 IP 或域名」），代价是 3 秒内必须处理完、每应用最多 50 条连接、多实例时只有随机一个收到。[CB-LC]
5. **需要人（飞书管理员）做的事：** 在开发者后台建企业自建应用、开机器人能力、申请上面两项权限、设可用范围（建议覆盖 4–5 个团队的部门）、发布版本，并**由企业管理员审核通过**才生效；以后改权限、改可用范围、加事件订阅都要再发版再审（管理员可对这个应用开「免审」）。另外公司防火墙要放行出站 `open.feishu.cn:443`，走代理的话 SDK 和自己写的 HTTP 都要配代理。[REVIEW][AVAIL][FAQ]

对平台的含义（供 #206 选型参考，不是决定）：「需要人回来处理」是发给具体某个人的，群机器人做不到，**应用机器人是唯一满足的方案**；群机器人可作为「团队群里广播」的零审批补充，但一个应用机器人发 `chat_id` 也能覆盖。现有 `NotificationChannel` 接口（`packages/api/src/notify/channel.ts`，`notify(notice)`）只有标题+正文，没有「发给谁」——接飞书要把收件人（平台用户的邮箱）带进来。

## 来源

| 编号 | 来源 | 取得日期 / 版本 |
| --- | --- | --- |
| [CB] | https://open.feishu.cn/document/client-docs/bot-v3/add-custom-bot（自定义机器人使用指南） | 2026-11-08 |
| [MSG] | https://open.feishu.cn/document/server-docs/im-v1/message/create（发送消息） | 2026-11-08 |
| [BGI] | https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id（通过手机号或邮箱获取用户 ID） | 2026-11-08 |
| [ID] | https://open.feishu.cn/document/platform-overveiw/basic-concepts/user-identity-introduction/introduction（用户身份概述） | 2026-11-08 |
| [TAT] | https://open.feishu.cn/document/server-docs/authentication-management/access-token/tenant_access_token_internal（自建应用获取 tenant_access_token，标为历史版本） | 2026-11-08 |
| [TAT2] | https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/authentication-management/access-token/tenant_access_token（新版：`accounts.feishu.cn/oauth/v3/token`） | 2026-11-08 |
| [DATA] | https://open.feishu.cn/document/api-call-guide/calling-process/configure-app-data-permissions（配置应用数据权限） | 2026-11-08 |
| [AVAIL] | https://open.feishu.cn/document/develop-process/test-and-release-app/availability（配置应用可用范围） | 2026-11-08 |
| [REVIEW] | https://open.feishu.cn/document/best-practices/intro-to-custom-app-review（发布与审核自建应用） | 2026-11-08 |
| [CB-LC] | https://open.feishu.cn/document/server-side-sdk/nodejs-sdk/handling-callbacks（Node SDK 处理回调：长连接 vs 回调地址） | 2026-11-08 |
| [CARD] | https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button（卡片 JSON 2.0 按钮） | 2026-11-08 |
| [FAQ] | https://open.feishu.cn/document/server-side-sdk/faq（服务端 SDK 常见问题） | 2026-11-08 |
| [FW] | https://www.feishu.cn/hc/zh-CN/articles/360044683233（配置企业内网防火墙域名和 IP 白名单，面向客户端） | 2026-11-08 |
| [SDK] | npm `@larksuiteoapi/node-sdk` 1.76.0 发布包 `lib/index.js`（2026-10-16 发布） | 2026-11-08 |

## 1. 自定义机器人（群 webhook）

来源 [CB]。

- **形态**：在某个群的设置里添加，「只能在当前群聊中使用」，不能加到别的群；不能响应用户消息。不需要在开放平台建应用。
- **调用**：`POST https://open.feishu.cn/open-apis/bot/v2/hook/<token>`，`Content-Type: application/json`。文档提醒不要把这个 URL 公开到 GitLab、博客等地方——**URL 本身就是凭证**。
- **安全设置**（可叠加）：
  - 关键词：最多 10 个，消息的文本值（`text`、`title` 等，不含 `href`）至少含一个。
  - IP 白名单：最多 10 个 IP / 网段。公司出口 IP 不固定时不好用。
  - 签名校验：待签字符串 `timestamp + "\n" + secret`，以它为 key 做 HmacSHA256（被签内容为空），结果 Base64，作为请求体的 `sign`；`timestamp` 秒级，和服务器时间差不超过 1 小时。
- **限频与大小**：单租户单机器人 100 次/分钟、5 次/秒；文档建议避开整点、半点发送；请求体 ≤ 20 KB。
- **消息类型**：`text`、`post`（富文本，含链接）、`share_chat`、`image`、`interactive`（卡片，用 `card` 字段代替 `content`）。
- **卡片限制**：按钮、文字链接能跳 URL；**不支持回传交互**；卡片里 @ 人要 open_id 或 user_id。
- **错误码**：`19021` 签名不对或时间戳超 1 小时，`19022` IP 不在白名单，`19024` 关键词不匹配，`11232` 系统压力限流，`9499` 请求体格式错。

## 2. 企业自建应用的机器人

### 2.1 拿 token

- 老接口（SDK 仍在用）：`POST https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal`，body `{app_id, app_secret}`，返回 `tenant_access_token` 和 `expire`（秒，示例 7200）。有效期最长 2 小时；剩余不足 30 分钟时再调会给新 token（新旧并存），否则返回同一个。文档页把它标为历史版本。[TAT]
- 新接口：`POST https://accounts.feishu.cn/oauth/v3/token`，`grant_type=client_credentials`，`client_id` / `client_secret`，可带 `scope`；有效期以响应 `expires_in` 为准，建议服务端缓存复用。[TAT2]
- 官方 Node SDK 1.76.0 的 token 管理器调的仍是老接口 `${domain}/open-apis/auth/v3/tenant_access_token/internal`，默认 domain `https://open.feishu.cn`（`Domain.Lark` 则是 `https://open.larksuite.com`）。[SDK] 所以只用老接口时出站只需 `open.feishu.cn`；用新接口还要放行 `accounts.feishu.cn`。

### 2.2 发消息

来源 [MSG]。

- `POST https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=<类型>`，`Authorization: Bearer <tenant_access_token>`，body `{receive_id, msg_type, content, uuid?}`。
- `receive_id_type`：`open_id`（推荐）、`union_id`、`user_id`（另需字段权限 `contact:user.employee_id:readonly`）、`email`（「以用户的真实邮箱来标识用户」，表格里没写额外限制）、`chat_id`。
- 权限（应用身份，任一即可）：`im:message`、`im:message:send_as_bot`、`im:message:send`（历史版本）。
- 前提：开启机器人能力并发布版本；**发给用户时用户须在机器人的可用范围内**；发到群时机器人须在群里且有发言权限。文档没有要求用户先和机器人说过话；但用户可以设置「不再接收机器人消息」（错误码 `230053`）。
- 限频：同一用户 5 QPS；同一群内所有机器人共享 5 QPS；接口整体 1000 次/分钟、50 次/秒。
- 大小：文本 ≤ 150 KB；卡片、富文本 ≤ 30 KB。
- `uuid`：≤ 50 字符，同一 uuid 1 小时内最多成功一次——可以用「事件 id」做 uuid 防重发。
- 常见错误码：`230013` 用户不在可用范围（或已离职），`230029` 已离职，`230053` 用户拒收机器人消息，`230002` 机器人不在群里，`230006` 没开机器人能力，`230027` 权限不足，`230035` 无发送权限（群禁言、被屏蔽等），`230020` 触发限频。

### 2.3 卡片：按钮跳回平台

来源 [CARD]。卡片 JSON 2.0 要显式写 `"schema": "2.0"`；按钮用 `behaviors`：

```json
{
  "schema": "2.0",
  "header": { "template": "red", "title": { "tag": "plain_text", "content": "票卡住" } },
  "body": { "elements": [
    { "tag": "markdown", "content": "S-12 登录页：门禁失败" },
    { "tag": "button", "text": { "tag": "plain_text", "content": "去处理" }, "type": "primary",
      "behaviors": [ { "type": "open_url", "default_url": "http://<平台内网地址>/specs/12" } ] }
  ] }
}
```

- `open_url` 可分端给 `default_url` / `pc_url` / `ios_url` / `android_url`；`ios_url` 设成 `lark://msgcard/unsupported_action` 表示该端不跳。文档没写对 http/https 的限制；**内网 `http://` 地址能否点开、手机端在外网点开会怎样，未确认，需实测**。
- `callback` 类按钮会触发 `card.action.trigger` 回调，见下一节。旧版「消息卡片回传交互」不支持长连接。[CB-LC]
- 应用发卡片：`msg_type=interactive`，`content` 是卡片 JSON 序列化后的字符串（与 webhook 的 `card` 字段不同）。

## 3. 平台用户 → 飞书用户

- **ID 体系** [ID]：`open_id`（`ou_` 开头）是用户在**某个应用**里的身份，不同应用不同；`union_id` 是同一应用开发商下各应用通用；`user_id` 是租户内身份（可能是管理员建人时指定的工号）。平台只建一个应用的话存 open_id 即可。
- **按邮箱/手机号换 ID** [BGI]：`POST https://open.feishu.cn/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id`，body `{emails: [...≤50], mobiles: [...≤50], include_resigned?: false}`，权限 `contact:user.id:readonly`，`tenant_access_token`；限频 1000 次/分钟、50 次/秒。返回 `data.user_list[]`，每项带 `user_id`（按 `user_id_type` 给出）和对应的 `email`/`mobile`；查不到时不报错、只是没有 ID。
- **查不到 ID 的原因**（文档原文列举）：token 不是这个应用的；邮箱/手机号不存在；没开这个权限；「使用企业邮箱查询将无法返回用户 ID，必须使用用户的邮箱地址」；用户已离职且 `include_resigned=false`；应用没有查看该用户的数据权限。
- **数据权限** [DATA]：「默认情况下，通讯录权限范围与应用的可用范围一致」；在 开发配置 › 权限管理 › 可访问的数据范围 里改，改完要发版、过审才生效。
- **对平台的含义**：GitLab 账号自带邮箱。最简单的链路是「平台用户邮箱 → 发消息时 `receive_id_type=email`」，不存飞书 ID；需要 @ 人或想提前发现「邮箱对不上」时，再用 `batch_get_id` 换 open_id 存起来。关键风险是**公司 GitLab 用户的邮箱是否就是飞书通讯录资料里的邮箱**（如果公司用飞书邮箱，资料里的邮箱字段可能另填），要拿 2–3 个真实账号核对；对不上就要在平台用户上留一个「飞书邮箱 / 手机号」可手填字段。

## 4. 内网只出站够不够

- **发通知够。** 换 token、查 ID、发消息都是平台主动 HTTPS 请求开放平台；卡片 `open_url` 由用户端打开，飞书服务器不回访平台。
- **点按钮直接操作也不必开入站**：长连接模式「只需保证运行环境具备访问公网能力即可，无需提供公网 IP 或域名」；回调地址（Webhook）模式才「需要你提供用于接收回调消息的服务器公网地址」。长连接限制：仅企业自建应用；每应用最多 50 个连接；集群模式，多个 client 时只有随机一个收到；收到后 3 秒内处理完。[CB-LC]
- **长连接的实际出站目标**：SDK 先 `POST ${domain}/callback/ws/endpoint`（带 AppID/AppSecret）拿到连接地址，再对返回的 `wss://` 地址建 WebSocket；这个地址的域名由服务端下发，不写死在 SDK 里。[SDK] 防火墙除 `open.feishu.cn` 外还要放行哪个 WebSocket 域名，**未确认，需实测**（看 endpoint 返回值）。
- **防火墙与代理**：SDK FAQ 写「非字节租户如果出现这个问题（dial tcp … i/o timeout），通常是因为公司设有防火墙，需要将 open.feishu.cn 这个域名加白」[FAQ]。Node SDK 的 `WSClient` 接受 `agent` 参数传给 WebSocket、`Client` 可换 `httpInstance`，走 HTTP 代理时可从这里注入。[SDK] 飞书帮助中心另有一份客户端用的域名/IP 白名单 [FW]，不针对服务端 API。
- 结论：只要公司服务器（或它的出站代理）能访问 `open.feishu.cn:443`，本票的三件事（发个人、发群、按邮箱找人）都成立；不需要飞书回调进内网。

## 5. 要飞书管理员配合的事

- 建企业自建应用、开机器人能力、申请权限（`im:message:send_as_bot`；`contact:user.id:readonly` 如果要换 ID）、设可用范围，然后**发版本并由企业管理员审核**。改「基础信息、权限范围、应用能力、事件订阅」都要再发版过审；管理员可在 工作台 › 应用管理 › 配置 里给这个应用开「免审」，或在「自建应用免审规则」里统一设。[REVIEW]
- 可用范围：开发者改要「提交版本审核，在通过企业管理员审核正式上线之后，新的可用范围才会生效」；管理员可以不发版直接改。新团队接入时，若其成员不在可用范围内，发给他们会报 `230013`——接入流程里要有「把这个团队加进可用范围」一步。[AVAIL]
- `app_id` / `app_secret` 作为控制面的密钥存放（和 GitLab bot token 同级）；群 webhook URL 同理。

## 未确认，需实测

1. 公司 GitLab 用户邮箱与飞书资料邮箱是否一致（`batch_get_id` 拿真实邮箱试）。
2. `receive_id_type=email` 是否额外需要通讯录权限 / 数据范围（文档没写）。
3. 卡片按钮跳内网 `http://` 地址在桌面端、手机端的表现。
4. 长连接 endpoint 返回的 WebSocket 域名，及公司出站代理下能否连通。
5. 公司管理员对自建应用的审核方式（是否可开免审）。
