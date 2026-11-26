# Linear 产品分析

核对日期为 2026-11-23。依据 Linear 官网、Start Guide、帮助文档、开发者文档和更新日志。下文的流程是按公开能力构造的示例，交互效率与实际工作区中的配置结果未经实测。 [Linear 官网](https://linear.app/) · [Start Guide](https://linear.app/docs/start-guide)

## 从 Start Guide 看产品主线

**Linear 用同一条 Issue 贯穿反馈、承诺、执行和结果。** 提报人可以从已经工作的渠道提交信息，团队可以决定是否接单，执行者可以接手并关联产出，提交方也有机会在原渠道得到回应。Start Guide 把 Intake 放在 Planning 和 Issues and cycles 之前，把 Reviews、Agents and automation、Insights 放在后面。按这个顺序学，比从看板字段开始更容易理解 Linear 为什么要同时做收件、任务管理和 Agent。 [Start Guide](https://linear.app/docs/start-guide) · [Linear Asks](https://linear.app/docs/linear-asks) · [GitHub 集成](https://linear.app/docs/github)

| 对象 | 回答的问题 | 产品行为 |
| --- | --- | --- |
| Workspace / Team | 工作在哪个组织内，由哪支团队负责？ | Workspace 容纳团队与其他对象。每条 Issue 归属一个 Team，使用该团队的状态、Triage 和计划节奏。 [Concepts](https://linear.app/docs/conceptual-model) |
| Issue | 要完成或处理哪件事？ | 创建所需的信息很少，Issue 有团队、标题、状态和可引用的 ID，后续可补说明、优先级、负责人、关系和评论。 [Issues](https://linear.app/docs/creating-issues) |
| Project / Milestone / Initiative | 这件事贡献哪个交付结果和更大的目标？ | Project 可以跨团队，Issue 同时只归一个 Project。Milestone 在 Project 内标记有意义的阶段，Initiative 汇集服务同一方向的多个 Project。 [Projects](https://linear.app/docs/projects) · [Concepts](https://linear.app/docs/conceptual-model) |
| Cycle / View | 团队这段时间做什么，从哪里看？ | Cycle 是团队可选的滚动计划周期。View 是同一批记录的筛选和呈现，个人、团队和跨团队可以各看自己关注的集合。 [Cycles](https://linear.app/docs/use-cycles) · [Concepts](https://linear.app/docs/conceptual-model) |

状态表达推进到哪里，Team 表达团队归属，Project 表达交付归属，Cycle 表达近期计划。让这些信息各有自己的位置，团队就可以在同一个 Project 下保留各自的工作流，也能在调整当期范围时保留 Issue 原有的上下文。Linear Method 建议把较大的用户体验和产品问题放到功能或 Project 层讨论，再把 Issue 写成具体、可交付的任务。这也解释了为什么“能快速创建”和“适合委派”可以对同一对象提出不同的信息要求。 [Concepts](https://linear.app/docs/conceptual-model) · [Linear Method 的 Issue 写法](https://linear.app/method/write-issues-not-user-stories) · [云端编码文档的 Issue 写法](https://linear.app/docs/linear-cloud-coding-agent)

## 一条 Issue 如何走完

1. **创建与补充。** 成员可以用 `C` 快速建单，也可以使用团队模板预填属性或引导补充资料。已知范围的小工作可以进入团队工作流，启用 Triage 的团队也可以专门处理来自集成或其他团队的输入。 [Issues](https://linear.app/docs/creating-issues) · [Issue templates](https://linear.app/docs/issue-templates) · [Triage](https://linear.app/docs/triage)
2. **承诺与拆分。** 默认工作流包含 Backlog、Todo、In Progress、Done、Canceled。团队可以在固定排列的类别内自定义状态，默认新单状态可选 Backlog 或 Todo 类别。负责人、优先级和 Cycle 决定谁在何时处理。较大的事项可拆成子 Issue，跨事项阻塞用 Issue relations 表达。普通未完成事项通常滚入下一 Cycle，文档列有冷却期例外。 [Issue properties](https://linear.app/docs/issue-property) · [Parent and sub-issues](https://linear.app/docs/parent-and-sub-issues) · [Cycles](https://linear.app/docs/use-cycles)
3. **执行与评审。** 通过分支名、PR 标题或描述中的 Issue ID 建立关联后，GitHub 事件可以按团队配置推动状态。例如有关闭语义的 `Fixes` 可在合并时触发目标状态，`Refs` 保留部分贡献的语义，`Related to` 只建立关联。人或 Agent 给同一条 Issue 交付 PR，评审者可以在 Reviews 检查 diff 和讨论。 [GitHub 集成](https://linear.app/docs/github) · [Reviews](https://linear.app/docs/diffs) · [云端编码 Agent](https://linear.app/docs/linear-cloud-coding-agent)
4. **完成与发布。** Done 表示团队定义的工作完成。在配置 PR 合并后进 Done 的团队，合并到预发分支也可能先于客户收到变更。Releases 通过 CI/CD 按产品和环境记录发布，将已纳入某次发布的 Issue 汇总起来。 [GitHub 集成](https://linear.app/docs/github) · [Releases](https://linear.app/docs/releases)
5. **回复与归档。** 客服可以从 Asks 的同步讨论串回应提报人，告知发布版本或下一步。已关闭并达到配置的不活跃时长后，符合条件的 Issue 会自动归档。归档记录仍可搜索，也可从团队归档恢复。 [Linear Asks](https://linear.app/docs/linear-asks) · [Delete and archive issues](https://linear.app/docs/delete-archive-issues) · [Issue properties](https://linear.app/docs/issue-property)

同一个“完成”若既表示代码合并、又表示客户用上新版本，团队、客服和自动化就会读取出不同的含义。Linear 给工作流、代码评审和发布各自的记录，允许它们在不同时间完成。对跨平台功能尤其重要，Web 可能已上线，移动端版本仍在等待发布。 [Releases](https://linear.app/docs/releases)

## Triage 如何保护团队的工作队列

**Triage 的核心决定是接不接、接到哪里。** 团队启用后，集成建单、其他团队成员建单和在 Triage 视图内建单一般默认进入这一状态。默认模板可以覆盖该状态。常规视图默认隐藏 Triage，跨团队看板若要统计待分诊工作，需要明确把它纳入筛选。通过 Asks 可从 Slack、邮件或表单提报并继续对话，通过 Customer Requests 可在既有 Issue 或 Project 下积累来自不同客户的原始反馈。 [Triage](https://linear.app/docs/triage) · [Linear Asks](https://linear.app/docs/linear-asks) · [Customer Requests](https://linear.app/docs/customer-requests)

| 处理动作 | 对团队和提报人的影响 |
| --- | --- |
| Accept | 进入团队默认状态，可留说明。团队可以要求离开 Triage 前设置优先级。默认状态可以是 Backlog，因此接单和开始执行可以发生在不同时间。 [Triage](https://linear.app/docs/triage) · [Issue properties](https://linear.app/docs/issue-property) |
| Decline | 进入 Canceled 类别，可说明拒绝原因，留下决定。 [Triage](https://linear.app/docs/triage) |
| Mark as duplicate | 选择保留的原 Issue，将客户请求、同步的 Slack 讨论串和附件移过去，重复记录保留指向原单的链接。属性文档和发布记录称其使用专门的 Duplicate 状态，Triage 页面仍按 Canceled 描述。 [Issue properties](https://linear.app/docs/issue-property) · [Duplicate 更新记录](https://linear.app/changelog/2026-05-21-project-slack-channels#issue-duplicates) · [Triage](https://linear.app/docs/triage) |
| Snooze | 暂时移出队列，在指定时间或有新活动时恢复，以先发生者为准。补问资料后可暂缓，也可保留在 Triage。 [Triage](https://linear.app/docs/triage) |

三套能力各解决一个问题。**Triage Responsibility** 决定谁看队列，可发通知或自动分配，固定名单按合资格成员轮值，轮值依据名单顺序。**Triage Rules** 负责明确的条件与动作，例如按表单字段路由，规则自上而下执行，转入另一团队 Triage 后还可触发目的团队规则。**Triage Intelligence** 用历史和语义查找相似项并建议团队、项目、负责人和标签，部分属性可设为自动应用。建议依据可查看，范围可缩到团队与子团队。官方预计新单建议要 1–4 分钟，紧急通道需要考虑这段等待。 [Triage](https://linear.app/docs/triage) · [Triage Intelligence](https://linear.app/docs/triage-intelligence)

创建 Issue 的成本很低，接受工作有独立的决定和负责人。去重还把“客户重复报告同一问题”变成同一处可积累的需求证据。对管理侧而言，分开看 Triage 的等待时间和已接工作量，能知道拥堵来自分诊还是交付。 [Triage](https://linear.app/docs/triage) · [Customer Requests](https://linear.app/docs/customer-requests)

## Agent 与 Loops 如何接入

| 能力 | 如何开始 | 典型结果 |
| --- | --- | --- |
| Linear Agent | 在聊天中询问，在评论里提及 `@Linear`，或把 Issue 委派给 Linear。重复使用的指令可保存为个人或团队 Skill。 | 在现有工作上下文中查资料、归纳反馈、更新工作对象，或按权限开展后续工作。 [Linear Agent](https://linear.app/docs/linear-agent) |
| Cloud coding agent | 工作区启用并授权仓库后，委派范围清楚的 Issue 或明确提出实现要求，可从 Loop 启动。 | 云端编码会话实现并验证变更，产出 draft PR；会话可带截图或录屏供评审。 [云端编码 Agent](https://linear.app/docs/linear-cloud-coding-agent) |
| Agent platform | 管理员安装第三方或自建 Agent，给定团队和权限，成员用委派或提及触发。 | 人继续作为 assignee 对 Issue 负责，Agent 作为 delegate 参与；支持的集成可回报会话进度、澄清请求和产出。 [Assign and delegate issues](https://linear.app/docs/assigning-issues) · [Agent platform](https://linear.app/docs/agents-in-linear) · [Agent interaction](https://linear.app/developers/agent-interaction) |
| Loops | 按时间表或受支持的事件后台运行，配置触发、匹配条件、自然语言指令和权限。 | 周期性汇总、收到事件后补充信息、按上下文创建后续 Issue，或委派实现。配置有发布版本，每次运行可从 Run history 回查。 [Loops](https://linear.app/docs/loops) |

**Loops 的触发和权限是产品功能。** 条件型触发在记录从不匹配变为匹配时运行，持续匹配期间的后续编辑不会逐次重跑。事件型触发在指定事件发生且筛选通过时运行，例如所选 GitHub 仓库上的 PR 合并事件。Issue 触发默认处理 Linear 内部创建的 Issue，Slack、邮件等外部来源需经工作区授权，并在具体 Loop 中开启。Slack 消息有独立触发方式。Triage Loop 属于特定团队，要求该团队开启 Triage。 [Loops](https://linear.app/docs/loops)

**给 Loop 配权限时要分别看它能读什么和能改什么。** 团队访问决定可触达的数据。配置允许的仓库后，可以单独给代码读取权限，再决定是否允许启动编码会话。按单个对象触发的 Loop 也可以限制为只修改触发对象，定时或 Slack 触发属于文档列明的例外。同步评论可能写回外部应用，需要专门授权。若委派给某些依赖个人账号的第三方 Agent，Loop 需要已有或新指定的有效人类 assignee，基本 Triage Rules 使用按规则或轮值自动分配的身份。 [Loops](https://linear.app/docs/loops) · [第三方 Agent 自动委派](https://linear.app/docs/assigning-issues#automated-delegation-to-third-party-agents)

截至核对日，定价页列出 Loops 覆盖 Free、Basic、Business、Enterprise。Loops 消耗 AI credits，余额耗尽时暂停运行。Triage 基础队列覆盖全部套餐，Rules、Responsibility 和 Intelligence 列在 Business 与 Enterprise。 [当前定价](https://linear.app/pricing) · [Loops](https://linear.app/docs/loops) · [Triage](https://linear.app/docs/triage)

人类 assignee 承担责任，Agent 委派表示谁在做这次工作，Loop 决定何时交给 Agent。产品保留 Issue、Agent 会话和 Loop 运行历史上的不同信号，让负责人能看出是工作尚未接单、Agent 在等澄清，还是自动化已经执行但缺权限。自然语言适合描述需要判断的工作，过滤条件和实际授权适合限制何时运行、能对什么生效。 [Assign and delegate issues](https://linear.app/docs/assigning-issues) · [Agent interaction](https://linear.app/developers/agent-interaction) · [Loops](https://linear.app/docs/loops)

## 客户导出空白页的处理示例

1. 客服在 Slack 提交 Asks，附上复现步骤、预期和版本。Issue 进入报表团队的 Triage。后续两个同类报告经核实并入第一条，保留客户证据和来源。 [Linear Asks](https://linear.app/docs/linear-asks) · [Triage](https://linear.app/docs/triage) · [Duplicate 更新记录](https://linear.app/changelog/2026-05-21-project-slack-channels#issue-duplicates)
2. 团队给 Triage Loop 开启对应的外部来源，并授予代码只读权限。Loop 对带报表标签的新单检查描述和相关实现，在运行记录留下代码位置、可能原因和仍欠缺的信息，供团队内部核对。值班人复现后接单，补充验收条件“启用分组汇总导出 PDF 时，首页应显示报表内容，CSV 导出维持现有行为”，指定负责人。 [Loops](https://linear.app/docs/loops) · [Triage](https://linear.app/docs/triage)
3. 负责人把范围明确的 Issue 委派给 Linear 云端编码 Agent。Agent 提供验证结果和 draft PR，负责人在 Reviews 查改动，按团队正常流程评审处理。团队配置允许关联的 PR 合并后推进 Issue 状态。 [云端编码 Agent](https://linear.app/docs/linear-cloud-coding-agent) · [GitHub 集成](https://linear.app/docs/github)
4. 生产发布关联该 Issue 后，客服核对对应版本，再从同步的提报渠道告知受影响客户。代码已合并且发布尚未发生时，可以先告知客户修复已合并、等待发布。 [Releases](https://linear.app/docs/releases) · [Linear Asks](https://linear.app/docs/linear-asks)

## 界面和交互怎样支持这些决定

- **常用动作可以沿多条路径触达。** 在 Issue 列表用 `J` / `K` 移动、`X` 选择，然后通过 `Cmd/Ctrl + K`、右键菜单或批量工具栏修改。右键菜单也会提示快捷键。用户初次使用时能从界面发现操作，熟练后可以沿用同样的操作语义来加速。部分视图支持按空格预览，快速浏览多条记录时可以保留列表的位置和上下文。 [Issues](https://linear.app/docs/creating-issues#select-issues) · [右键菜单设计](https://linear.app/now/invisible-details) · [Peek](https://linear.app/docs/custom-views#peek-preview)
- **筛选和显示各管一件事。** 筛选决定集合里有哪些 Issue，显示选项决定如何分组、排序、显示哪些字段以及采用列表或看板。把「本周高优 Bug」保存成共享 View 就能建立一块日常工作区，工程、客服和负责人仍然可以打开同一条记录。个人 Inbox 处理通知，Team Triage 处理新单，My Issues 查自己负责、创建或订阅的工作。 [Display options](https://linear.app/docs/display-options) · [Custom Views](https://linear.app/docs/custom-views) · [Inbox](https://linear.app/docs/inbox) · [My Issues](https://linear.app/docs/my-issues)
- **高密度页面保留清晰的视觉层级。** 2026 年的界面调整统一了不同页面的页头、导航和视图控件，弱化侧栏和分隔线、缩小部分图标，让正文、列表和当前动作更显眼。对工具软件，可借鉴的是先统一信息和动作的位置，再调字号、颜色与间距。官方设计文章有页头结构和侧栏前后对比图。 [UI refresh](https://linear.app/changelog/2026-03-12-ui-refresh) · [设计团队拆解](https://linear.app/now/behind-the-latest-design-refresh#what-changed-in-the-interface)
- **风险判断和完成量各有依据。** Projects 和 Initiatives 的 Updates 让负责人用 On track、At risk、Off track 和文字说明同步判断。Insights 则从 Issue 事件算 Triage Time、Cycle Time 和 Lead Time，分别对应分诊耗时、开工到完成和创建到完成。比如 Triage Time 变长而 Cycle Time 稳定，优先检查值班安排、输入质量或路由；这些数字也受团队状态定义和记录方式影响。 [Updates](https://linear.app/docs/initiative-and-project-updates) · [Insights](https://linear.app/docs/insights)

## 可借鉴的设计

- **用单据表达阶段之间的承诺。** 先允许提报并保存原话，接单时再确定团队、优先级与负责人，委派实现前补齐范围和可验证结果。这样不会要求提报人先了解内部组织或代码。 [Triage](https://linear.app/docs/triage) · [Linear Method](https://linear.app/method/write-issues-not-user-stories)
- **把可核实的事件用作流程信号。** 评审请求、PR 合并和生产发布都可以各自触发后续动作。应该用哪一个，取决于下一步需要确信什么。 [GitHub 集成](https://linear.app/docs/github) · [Releases](https://linear.app/docs/releases) · [Loops](https://linear.app/docs/loops)
- **自动化先从能回查的结果开始。** 让 Agent 补证据、提出重复项或生成评审清单，再按工作范围授予写权限。用合并到原单的准确率、人工改判次数和 Triage 等待时间来评估是否适合扩大范围。这些是研究提出的评估指标。 [Triage Intelligence](https://linear.app/docs/triage-intelligence) · [Loops](https://linear.app/docs/loops)

对 AFK，可借鉴的是在前置分诊保留原报告和证据、在后台动作旁展示责任人和执行记录。Linear 的 Issue 可覆盖客服请求到开发交付，AFK 的 Ticket 是属于一个 Spec、只改一个 Repo 的实现记录。Linear 的 Loop 可以凭上下文建议或启动工作，AFK 的 Spec 确认后，平台按依赖边调度实现，门禁约束流程推进。把线索和判断放在规划之前、把履约和验证留在已定义的流程中，符合 AFK 当前边界。 [Linear Agent](https://linear.app/docs/linear-agent) · [Loops](https://linear.app/docs/loops) · [AFK 术语表](../../GLOSSARY.md) · [AFK 设计原则](../design.md#设计原则)

## 学习路线

1. 先在官方 Demo 看一条 Issue，顺着它的 Team、Project 和 Cycle 走一遍，再切换列表和看板观察相同字段如何呈现。 [官方 Demo](https://linear.app/demo) · [Start Guide](https://linear.app/docs/start-guide) · [Board layout](https://linear.app/docs/board-layout)
2. 再看官方未计划工作教程的提报与处理示例，重点观察何时接受、何时补问、去重后证据去了哪里。 [Managing unplanned work](https://linear.app/learn/managing-unplanned-work)
3. 最后对照 Loops 文档的配置草稿和 Run history，观察如何把一次 Agent 对话变成团队可复用的工作。产品侧可以看「项目时间变化后同步发布计划」，工程侧可以看「新单到达后补证据或委派」。 [Loops](https://linear.app/docs/loops) · [Loops for product management](https://linear.app/changelog/2026-09-14-loops-for-product-management)
