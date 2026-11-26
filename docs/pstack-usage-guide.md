# pstack 中文使用指南

> 查阅日期：2026-11-17。基于 `cursor/plugins` 的提交 `e1cc03121a0e71129a4fb730d7c5528a0a3e43c8`，插件版本 **0.15.43**。以下命令已与官方文档及源码核对；本文没有在 Cursor 或 Claude Code 中实际安装、执行插件。示例是可改写的使用模板，不代表已经运行成功的结果。[版本信息][S0]

阅读路线：第一次使用先看第 2、3 节；选择具体任务看第 4、5 节；理解方法与落地边界看第 6、8、9 节。第 7 节可留作原则速查。

## 1. pstack 是做什么的？

**pstack 是一套面向 AI 编程 agent 的工程工作流插件。** 它把排查问题、比较设计、分工实现、验证结果、处理 PR 和复盘沉淀，组织成 agent 可以遵循的流程。作者是 Lauren Tan（poteto），项目采用 MIT 许可证。[项目说明][S1]

日常使用主要从 `/poteto-mode` 开始：告诉它目标和验收方式，它会选择流程，把步骤放进待办列表，再按需调用其他技能。当前版本提供 **22 个 playbook（任务流程）和 24 条工程原则**。[主入口源码][S2]

例如，你可以这样发起任务：

```text
/poteto-mode 用户连续点击两次导出，会得到包含重复记录的 CSV。
先复现，再查根因并修复。
完成条件：重复点击只产生一次有效导出，正常导出内容不变。
展示修复前后的实际输出。这一轮只在本地修改和验证。
```

它的价值在于让 agent 明确“下一步应该做什么”和“凭什么宣布完成”。从仓库结构看，核心实现是技能文件、流程文件和 agent 定义；流程也会调用脚本及宿主工具。**可以把它理解为运行在 AI 编程工具上的工程方法层。** 这是对其实现方式的归纳；调度能力、模型、权限和实际执行环境仍由宿主提供。[插件清单][S0]、[主入口源码][S2]

下面概括一个需要改代码的任务如何推进，具体步骤由匹配到的流程决定：

```mermaid
flowchart LR
    A[目标与验收条件] --> B[选择任务流程]
    B --> C[调查与设计]
    C --> D[实现或实验]
    D --> E{真实行为验证}
    E -->|通过| F[交付结果与证据]
    E -->|未通过| C
```

### 适合哪些人？

- 经常让 agent 做超过几步的开发，希望结果有证据可查。
- 需要比较方案、审查复杂改动，或并行推进多个独立范围。
- 想把项目的启动、操作、验证过程沉淀成可复用能力。
- 希望逐步把有人盯着的操作，变成边界明确的自主运行。

对于改错别字、调整一个明显常量这样的工作，完整工作流的额外调用和审查通常不划算。官方也建议把 `/poteto-mode` 留给需要工程严谨性的工作。[安装与成本指南][S3]

## 2. 安装与初始化

### 2.1 在 Cursor 中使用

在 **Cursor 聊天输入框**执行，以下不是终端命令：

```text
/add-plugin pstack
```

安装后执行：

```text
/setup-pstack
```

它会识别当前可用模型，让你选择推理预算，以及实现、判断、评审等角色使用的模型，最后写入：

```text
~/.cursor/rules/pstack-models.mdc
```

配置完成后新开聊天，让模型规则在新会话中生效。[初始化指南][S3]、[配置技能源码][S4]

官方还建议搭配 `cursor-team-kit`。pstack 的部分流程会使用其中的 `/deslop`、`control-cli` 和 `control-ui`。这些能力没有打包在 pstack 里，不能把它们当成安装 pstack 后就必然可用的命令。[外部依赖说明][S1]

### 2.2 在 Claude Code 中使用

在 Claude Code 中执行：

```text
/plugin marketplace add cursor/plugins
/plugin install pstack@cursor-plugins
```

Claude Code 中的插件命令带命名空间：

```text
/pstack:setup-pstack
/pstack:poteto-mode 排查这个导出问题，先复现再修复。
```

模型配置文件也相应变为：

```text
~/.claude/rules/pstack-models.md
```

第三方市场的自动更新默认关闭。需要时，在 `/plugin` 的 marketplaces 页面为 `cursor-plugins` 开启自动更新；也可以在终端手动更新：

```sh
claude plugin update pstack@cursor-plugins
```

Claude Code 使用仓库生成的适配版本。Cursor 云 agent 会映射为本地 worktree 隔离；Cursor Automations 等独有能力会跳过；非 Claude 模型的配置也不能原样保留。因此，**支持 Claude Code 不等于所有 Cursor 能力完全等价**。[安装说明][S1]、[Claude Code 适配说明][S5]

本文核对的官方适配目录只列出了 Claude Code，未发现对应的 Codex 适配说明。不要直接把 Cursor 的工具名、模型标识和命令当成其他宿主的通用接口。[适配目录][S6]

### 2.3 第一次如何选模型与预算？

建议第一次使用 `/setup-pstack` 的交互配置，让它以当前账号实际可用的模型为准。不要照抄网上某个模型名称。当前源码要求写入的真实模型标识必须经过可用性检查。[配置技能源码][S4]

| 配置 | 含义 | 使用建议 |
| --- | --- | --- |
| `large` | 保留各角色默认推理档位 | 复杂设计、难复现问题可考虑 |
| `medium` | 在各角色默认档位上降低一级 | 建议先用它观察日常任务成本 |
| `small` | 在各角色默认档位上降低两级 | 较直接的实现、检查和试用 |
| `auto` / `inherit-parent` | 不指定子 agent 的模型，让其继承主聊天模型 | 希望沿用当前聊天模型时使用 |
| 缩短候选或评审列表 | `arena runners`、`interrogate reviewers` 每个列表项各启动一个 agent | 控制并行调用量 |

预算调整按角色默认档位计算，并受最低档位和模型可用性限制，不能理解为所有角色一律运行在同一档。它也不是金额或 token 的硬上限。上表的使用建议是本文建议，配置语义来自源码。[配置技能源码][S4]

`arena cross-judge pool` 也是列表，但它按顺序选择一个可用的异供应商 judge，不会为每个列表项各启动一个 judge。[配置技能源码][S4]

升级后如果角色仍使用旧默认值，重新运行 `/setup-pstack`。当前版本能迁移它识别出的旧默认配置，并保留其他自定义选择；删除某个角色行可以恢复该角色的技能默认值。[配置技能源码][S4]

## 3. 基本使用：先掌握一个入口

### 3.1 提示词的五个要素

通常不必手写技能调用顺序。给出以下信息就足够：

1. **目标**：想解决什么问题。
2. **完成条件**：什么结果能判定通过或失败。
3. **证据**：希望看到真实命令输出、截图、存储值还是性能数据。
4. **已知信息**：输入样本、日志、复现步骤、相关链接。
5. **约束与权限**：是否只读、是否允许提交、是否允许开 PR、是否允许合并。

这是官方推荐的提示方式。不要只说“优化一下”或“处理四小时”，因为它们没有可检查的终点。[任务路由指南][S7]

通用模板：

```text
/poteto-mode [目标与已观察到的现象]。
相关输入或线索：[路径、链接、日志]。
完成条件：[可以执行的检查]。
请展示：[实际输出、截图、数据或其他证据]。
约束：[行为边界、允许的操作范围]。
```

### 3.2 一个完整的 Bug 修复流程

假设你维护一个命令行导出工具：

```text
/poteto-mode export 在重试后产生重复行，样本在 fixtures/retry-case.json。
先复现，再修复；通过公开 CLI 验证。
完成条件：每个业务 ID 只出现一次，正常样本的导出结果不变。
给我修复前后的行数与重复 ID 检查结果。
只做本地修改，不提交、不推送、不开 PR。
```

Bug fix 流程要求先取得复现证据，再排除假设，确认故障机制后实现修复，最后在原来的操作入口重新验证。如果存在成本合适的测试路径，会使用先失败再修复的节奏；该插件也允许在测试路径昂贵或不合适时使用其他可执行检查。[Bug fix 流程][S8]

在本 AFK 仓库工作时，仍应遵守仓库更严格的“新行为先写测试”要求，不能用插件的通用例外覆盖项目规范。

你应该从最终报告中看见：

- 原问题如何触发，以及它确实失败的证据。
- 根因与改动之间的因果关系。
- 同一个复现路径修复后通过的证据。
- 回归检查结果，以及没有完成或无法验证的部分。

不要仅凭“构建成功”认定问题已修复。CLI 改动应运行 CLI，存储改动应读回数据，UI 改动应操作真实界面。[验证指南][S9]

### 3.3 让模式持续生效，以及切换任务

Cursor 中，从 `/` 菜单选择技能后，用 Mac 的 Option+Enter 或 Windows 的 Alt+Enter 将其作为 Custom Mode 使用。官方说明这种方式会让技能持续留在各轮上下文中；普通 Enter 只附加到当前消息。该功能适用于官方列出的 Agents Window 和 CLI。[初始化指南][S3]

长聊天中切换主题时，明确写 `new task`，同时说明新的操作范围：

```text
/poteto-mode new task. 调查退出登录后缓存为何仍然存在。
只读调查，不修改代码。
```

这样可以触发重新匹配流程，减少 agent 把新问题当成上一项开发工作的后续步骤。[任务路由指南][S7]

### 3.4 不知道用哪个技能时

```text
/poteto-help 我想检查当前分支有没有行为回归，应该怎么发起？
```

它会解释适用的用法，给出待发送的提示词和来源链接，不会替你启动任务。`/sharpen` 则用于改进一个尚未发送的任务描述；它交付改写后的提示词，也不直接执行该任务。[帮助说明][S1]、[提示方式][S7]

## 4. 使用场景与命令速查

以下使用 Cursor 命令名；在 Claude Code 中手动调用时增加 `pstack:` 前缀。大部分任务可以直接交给 `/poteto-mode` 路由。[命令说明][S1]

| 你的问题 | 入口 | 应得到什么 |
| --- | --- | --- |
| 陌生模块现在怎么运行？ | `/how` | 调用链、状态和数据流的解释 |
| 为什么当时这样设计？ | `/why` | 提交、PR 讨论等历史依据；推断单独标明 |
| 想真正理解一个改动 | `/teach` | 结合运行机制与历史原因的讲解 |
| 忘记此前讨论到了哪里 | `/recall` | 从自己的相关聊天及共享记录重建背景 |
| 离开一会儿，想知道进度 | `/ketchup` | 本聊天新增进展、证据和待你决定的事项 |
| 修复 Bug | `/poteto-mode` | 复现、根因、修复与原路径验证 |
| 新功能或结构重构 | `/poteto-mode` | 明确数据结构、边界及行为证据 |
| 设计接口、模块或状态归属 | `/architect` | 从调用方出发的结构方案 |
| 同一问题想要多个独立方案 | `/arena` | 候选比较、选择与综合后的验证 |
| 不同模块要并行检查 | `/swarm` | 分范围执行与统一汇总 |
| 怀疑代码有缺陷，想做对抗审查 | `/interrogate` | 经实际运行确认的问题与被排除项 |
| 已有便宜、稳定的测试路径 | `/tdd` | 先看到测试因预期原因失败，再实现修复 |
| 应用启动慢、操作卡 | `/poteto-mode` | 基线、剖析、修复前后对比 |
| 已有 CPU profile 等采样文件 | `/poteto-mode` | Trace forensics 诊断，可明确要求先不修复 |
| 性能数字是否可信？ | `/benchmark-checklist` | 测量限制、重复性和结论可信度 |
| 为项目建立实际操作验证 | `/create-verification-skill` | 项目专属验证技能与可复查证据 |
| 检查并发、重试、状态机的关键性质 | `/create-formal-verification-skill` | 给定模型或范围内的检查与反例 |
| 检查改动的连带影响 | `/blast-radius` | 影响范围与关键安全前提的验证 |
| 清理文字中的模板腔 | `/unslop` | 更清楚、直接的文案 |
| 审查代码注释 | `/no-comments` | 独立注释审查及接受后的整改 |
| 追踪长任务中的取舍 | `/show-me-your-work` | 带证据指针的决策记录 |
| 老是纠正同一类 agent 错误 | `/correct` | 架构、类型、检查或测试层面的防复发改动 |
| 把本轮经验沉淀下来 | `/reflect` | 技能改进提案，批准后再修改 |
| 想建立自己的工作风格 | `/automate-me` | 根据历史工作记录生成或更新个人模式 |

这张表归纳自[官方技能索引][S1]、[设计指南][S10]、[构建指南][S11]和[定制指南][S12]。下面展开最值得掌握的高阶用法。

## 5. 高阶使用

### 5.1 比较方案、覆盖范围、对抗审查如何选择？

| 工具 | 工作如何分配 | 汇总方式 | 典型场景 |
| --- | --- | --- | --- |
| `/arena` | 多个 agent 做同一份题目 | 选择基础方案，吸收其他候选的优点并验证 | 缓存设计、接口形状、实现策略 |
| `/swarm` | 不同独立范围，或预先声明规则的竞赛分支 | 汇总覆盖结果、缺口和异常 | 多包检查、功能矩阵验证、探索分区 |
| `/interrogate` | 不同评审者尝试证明现有改动有问题 | 保留运行证实的问题，并列出被排除项 | 复杂 diff、回归风险、边界条件 |

`arena` 的跨供应商评判依赖模型可用性。如果找不到可运行的其他供应商模型，官方流程由协调者自行选择基础方案。多模型不是永远能获得的保证。[设计指南][S10]

示例一，对一个昂贵、难撤销的设计做多方案比较：

```text
/arena 为导入任务设计取消机制，给出 3 个候选。
使用相同约束：取消可重复、重启后状态一致、调用方接口清楚。
各候选使用独立目录或 worktree。
比较调用方式、状态归属、异常路径和验证成本。
这一轮交付设计与可运行原型，不修改主实现。
```

示例二，按独立范围检查：

```text
/swarm 检查 packages 下各包的公开接口是否与现有文档一致。
每个 worker 负责一个包，只读检查。
汇总 PASS、ISSUES、BLOCKED，并列出未覆盖范围。
```

示例三，对已有代码做审查：

```text
/interrogate 检查本分支的租约重试改动。
只保留能通过运行证明的行为错误。
重点检查租约过期与重试交错，不修改代码。
列出被排除的问题及排除证据。
```

并行写代码必须隔离文件和运行资源。云 agent 的隔离能力更完整；本地 worktree 能隔离检出文件，但端口、数据库和其他外部资源仍需要分配。这一点是根据隔离机制作出的工程判断。[并行工作指南][S7]

### 5.2 把“你帮我点一下看看”变成验证基础设施

```text
/create-verification-skill
```

生成器会调查仓库，识别启动方式、操作入口和证据形式。Cursor 下通常写入 `.cursor/skills/verify-<app>/`，包含 Launch、Doctor、Drive、Evidence、Cleanup 等操作说明，以及按功能组织的 feature map。交付前必须实际走通一轮，包括清理后证据仍然存在。[验证技能指南][S9]

之后可以这样要求验证：

```text
/poteto-mode 为列表增加批量归档。
用 /verify-<app> 操作真实应用，验证成功、失败和重复操作。
给出截图以及归档后读回的数据。
```

这里的 `<app>` 必须替换为项目实际生成的技能名。

应用变化后，使用 `/maintain-verification-skill` 检查功能映射与操作说明是否过时。该技能的职责限于验证技能自身；实际操作发现产品回归时，应报告回归，不能通过改验证说明让它“通过”。[维护说明][S9]

**本文建议**：先建立一个可靠的验证路径，再扩大自主执行和并行量。能够重复检查结果，是放手让 agent 继续工作的基础。

### 5.3 性能优化：一次排查与持续爬坡

一次性能排查可以这样发起：

```text
/poteto-mode 同一个 5 万条记录样本，首次打开列表需要约 2 秒。
先建立可重复基线并采样，找出实际耗时路径，再优化。
展示交替多次运行的中位数、波动、错误数与处理记录数。
```

持续优化一个指标时，使用 Hillclimb 流程的任务表述：

```text
/poteto-mode 对导入吞吐做 hillclimb。
固定数据集、机器条件和测量脚本，回归检查必须始终通过。
目标是中位吞吐比基线提高 25%，并至少完成 8 次实验。
每轮一个假设，记录保留或回退的证据；单独记录达不到目标的原因。
只做本地实验，不推送或合并。
```

Hillclimb 要先确认真实工作负载，再建立并验证测量脚本，随后冻结它。每轮改变一个假设，测量并运行回归检查，收益超过噪声才保留；没有帮助的修改回退，接受的收益分别提交。不能通过减少实际工作量、改变统计口径或悄悄降低目标宣布成功。[Hillclimb 流程][S13]

`/benchmark-checklist` 用于审查数字是否测到了声称的工作、是否被其他瓶颈限制、结果是否可重复，以及改善是否作用于用户等待的完整路径。[性能数字检查][S9]

### 5.4 形式化验证：检查测试难覆盖的交错

```text
/create-formal-verification-skill 检查作业租约和重试逻辑。
关键性质：任意时刻，一个作业最多只有一个拥有有效租约的执行者。
明确建模假设、检查范围，以及模型怎样对应实际代码。
```

该技能按问题选择工具：事件顺序问题适合模型检查；代码输入性质适合针对代码的验证工具；没有合适验证器时，流程也可能使用真实代码上的生成式输入检查。**这些方法的保证强度不同，需要看交付说明，不能因为技能名里有 formal 就当成完整数学证明。**[形式化验证说明][S9]

值得关注的交付内容：

- 精确定义的一条性质及其成立假设。
- 检查的模型、范围或边界。
- 错误变体确实能让检查失败的证据。
- 发现问题时，用业务术语描述的反例步骤。
- 后续修改如何重跑检查，以及检查不覆盖什么。

模型通过，只证明模型或指定范围内的结论。模型与代码之间的对应关系仍须维护；代码变化后可使用 `/maintain-formal-verification-skill`。[形式化验证说明][S9]

### 5.5 长任务与无人值守运行

先让 agent 在你能观察的情况下完成几次相同类型任务，确认它有稳定的检查手段，再考虑无人值守。[自主运行指南][S14]

一个边界清楚的交接可以写成：

```text
/poteto-mode 我接下来不在线，请继续执行直到完成条件满足，不要因此暂停。
在独立 worktree 中，把所有调用方迁移到新解析器。
完成条件：旧调用数为零，回归检查通过，旧内部 API 已删除。
允许本地提交；不允许推送、合并、部署或删除业务数据。
记录决策和证据。无法继续时保留可恢复状态并说明原因。
```

这里的“我不在线”是工作方式说明，权限仍以写明的范围为准。主入口包含自主执行规则和对不可逆操作的暂停要求，各交付流程也有自己的边界。[自主规则][S2]

Cursor 的 `/loop` 是宿主提供的唤醒能力，不是 pstack 自带的后台服务。机器关闭后是否继续运行取决于实际使用的宿主与执行环境；官方指南介绍了 Cursor 云 agent 和 Projects 作为持续运行的方式。[自主运行指南][S14]

长任务会使用 `/show-me-your-work` 记录决策。通用日志是 TSV，包含时间、阶段、决定、原因、证据指针与结果，默认保存在本地 `decisions.tsv` 或 `.audit/<task-slug>.tsv`，不默认提交。特定实验流程可能另有实验记录字段，应以该流程为准。[决策日志源码][S15]、[Hillclimb 流程][S13]

回来后可以运行：

```text
/ketchup
```

快速了解进展；需要审计取舍时，使用 `/show-me-your-work` 查阅日志及其证据。日志里写了“通过”，仍要能追到实际输出或产物。[自主运行指南][S14]、[决策日志源码][S15]

### 5.6 PR 跟进、交付、自动合并的区别

| 流程 | 工作范围 | 停在哪里 |
| --- | --- | --- |
| Babysit | 跟踪冲突、审查线程和 CI；也支持只问状态 | 到可合并，不自动合并 |
| Shipping | 独立验证 PR，按依赖从底部交付连续通过的部分 | 执行交付；需要相应操作授权 |
| Autopilot-stack | 处理一批改动，构建、验证并准备 PR | 交给人审查和合并 |
| Autopilot-full | 为队列中的 PR 分配 owner，并独立验证将要落地的代码 | 在授权范围内推进到合并 |

来源：[交付指南][S9]、[Autopilot-stack][S16]、[Autopilot-full][S17]。

**重要的使用细节**：Bug fix、Feature 等多个实现流程以 Opening a PR 作为收尾步骤。因此，即使你只想本地试一下，也应明确写出“不提交、不推送、不开 PR”。[Bug fix][S8]、[Feature][S18]

验证结论必须对应实际落地的补丁。Autopilot-full 区分补丁验证与提交上的 CI；后续修改、变基或依赖变化可能需要重新验证，不能拿早先某次通过的结论覆盖后来的代码。[Autopilot-full][S17]

### 5.7 自动触发：Benny

pstack 附带 Benny 自动化包，面向 Slack 问题报告，提供报告分诊，以及确认后复现、必要时准备小型草稿修复的流程。它默认处于未启用状态，不注册为普通斜杠技能。[Benny 说明][S19]

配置入口是该包的 `FOR_AGENTS.md`。安装流程会把自动化来源复制到目标仓库的 `.cursor/automations/benny/`，配置保存在包之外，并在启用前检查自动化草稿及测试报告。这依赖 Cursor Automations，在 Claude Code 中不会获得同等能力。[Benny 说明][S19]、[Claude Code 适配][S5]

### 5.8 形成自己的工程习惯

| 命令 | 解决的问题 | 产物 |
| --- | --- | --- |
| `/automate-me` | 希望 agent 使用自己的协作风格 | 从相关工作历史提取习惯，生成或更新个人模式 |
| `/reflect` | 一次任务中出现了可复用经验 | Accepted、Rejected、Backlog 提案，批准后再改技能 |
| `/correct` | 同类错误反复发生 | 优先用架构、类型、检查或测试消除错误类别 |

技能调整应独立审查，不要在功能任务中顺手大改整个工作方式。对重要变更，可以使用 Eval 流程，让不同版本在同一任务上盲测；候选不知道自己在参加评测，以减少迎合评价的行为。[定制指南][S12]

## 6. pstack 体现的工程思想

以下是基于源码机制的归纳，不是作者原话，也不是已经测量出的提效结论。

### 6.1 用可执行的完成条件约束自主权

agent 可以自主选择实现路径，但“完成”必须落在明确检查上。Bug 修复回到原复现路径，性能优化回到固定测量脚本，UI 迁移回到截图比较。自主权与证据要求一起增加，才有可审查性。[Bug fix][S8]、[Hillclimb][S13]、[验证指南][S9]

### 6.2 从数据形状和状态归属出发设计

主入口要求先命名数据结构，跨函数边界时使用 `architect`。Feature 流程进一步要求明确状态机、类型模型或表结构等组织方式。其工程含义是：先让系统的结构表达业务，再编写围绕结构的逻辑，减少散落的条件判断。[主入口][S2]、[Feature 流程][S18]

### 6.3 并行前先消除共享写入

Feature 流程显式检查阻塞步骤、独立工作流、共享可变状态和最小安全拆分。`arena`、`swarm` 又分别解决同题比较和范围覆盖。并行的前提是能定义边界、隔离副作用、独立验收，而不是把 agent 数量拉高。[Feature 流程][S18]、[设计指南][S10]

### 6.4 把作者和评判者分开

候选比较、对抗审查和自动交付都包含独立评判机制。作者容易接受自己的解释，独立评判者应检查实际行为与证据。模型多样性可以增加发现不同问题的机会，但多个模型一致同意仍不等于事实成立。[设计指南][S10]、[Autopilot-full][S17]

### 6.5 将验证能力当成项目资产

验证技能把启动、驱动、证据采集和清理过程显式化。下一个 agent 可以复用这些步骤，团队也能检查“通过”究竟意味着什么。可复跑的工具比每轮重新写一遍操作说明更容易积累可靠性。[验证技能指南][S9]

### 6.6 用结构承载经验，减少反复提醒

`correct` 的修复优先级是架构与数据结构、类型或自动检查、测试，最后才是文档规则。反复犯错时，应寻找能让错误无法表达、或立即失败的约束。`reflect` 则负责把一次工作中的经验提炼为后续技能改进。[定制指南][S12]

### 6.7 尽量减少需要长期理解的代码

Laziness Protocol、Subtract Before You Add 和 Minimize Reader Load 都偏向删除冗余、减少层级和缩小可变状态。这里的“小”是长期理解与维护成本的降低；必要的验证工具和证据可能增加当前工作量，却减少以后每次交接的负担。[原则索引][S1]、[主入口][S2]

### 6.8 用实验回答能实测的问题

可以运行的原型，用来解决布局、算法或实现路线的分歧；能反复测量的性能改动，用一轮一假设的实验处理；无法实测的偏好和产品选择，保留给人判断。这避免把长篇方案讨论误当成设计已经被验证。[设计指南][S10]、[Hillclimb][S13]

### 6.9 区分流程约定与强制约束

技能文件里的步骤，首先依赖 agent 正确读取和遵循。命令授权、保护路径、自动检查与合并规则，应在实际工具和仓库中落实。`correct` 明确把“写规则文档”放在最后，因为跳过文字规则本身不会让程序失败。这也说明采用工作流之后，仍需要可以独立执行的门禁。[纠错技能源码][S21]

## 7. 24 条原则速查

原则名可作为中途纠偏的词汇，例如：“应用 `prove-it-works`，展示原复现路径的结果。”下表是对当前原则索引的中文概括，不代表每次任务必须机械套用全部原则。[原则索引][S1]、[主入口][S2]

| 分组 | 原则名 | 中文要点 |
| --- | --- | --- |
| 核心 | `laziness-protocol` | 优先删除，做解决问题所需的最小改动 |
| 核心 | `foundational-thinking` | 先选核心类型、数据结构和工作顺序 |
| 核心 | `redesign-from-first-principles` | 按新需求本来就存在的前提重新看设计 |
| 核心 | `attack-the-premise` | 连续失败时直接检验共同前提 |
| 核心 | `subtract-before-you-add` | 先清掉冗余再扩展 |
| 核心 | `minimize-reader-load` | 减少读者需要记住的隐藏状态和跳转层级 |
| 核心 | `outcome-oriented-execution` | 迁移围绕目标结构收敛，避免无用过渡层 |
| 核心 | `experience-first` | 产品体验优先于实现方便 |
| 核心 | `exhaust-the-design-space` | 通过少量竞争原型探索方案 |
| 核心 | `build-the-lever` | 构建能执行或证明工作的可复跑工具 |
| 架构 | `model-the-domain` | 用结构表达领域规则 |
| 架构 | `boundary-discipline` | 在系统边界校验，内部保持清楚的契约 |
| 架构 | `type-system-discipline` | 用类型消除非法状态，类型从权威结构派生 |
| 架构 | `make-operations-idempotent` | 中断与重试后仍收敛到同一结果 |
| 架构 | `migrate-callers-then-delete-legacy-apis` | 迁完调用方后及时删除旧内部 API |
| 架构 | `separate-before-serializing-shared-state` | 优先拆开共享状态，再考虑串行化 |
| 验证 | `prove-it-works` | 检查真实产物和真实行为 |
| 验证 | `fix-root-causes` | 修复系统最早出错的位置 |
| 验证 | `sequence-verifiable-units` | 把工作和提交组织成逐步可验证的单元 |
| 验证 | `test-behavior-not-implementation` | 测用户能观察到的行为 |
| 验证 | `explain-the-number` | 解释数字的限制因素与实际测量对象 |
| 委派 | `guard-the-context-window` | 大量阅读和执行下沉，主聊天保留结论与指针 |
| 委派 | `never-block-on-the-human` | 在授权范围内推进可逆工作 |
| 元规则 | `encode-lessons-in-structure` | 把经验写进类型、检查和工具 |

## 8. 常见误区与排查

| 现象或误解 | 应如何处理 |
| --- | --- |
| “安装后，所有聊天会自动进入 pstack” | 从 `/` 菜单显式选择技能；需要持续时使用宿主支持的 Custom Mode |
| “列出越多技能，效果越好” | 先写目标、验收和约束，只在想覆盖默认选择时点名技能 |
| “`unslop` 会清理代码” | 它主要处理文字；代码清理由外部 `/deslop` 承担，注释审查用 `/no-comments` |
| “有 `no-comments`，就应该删除所有注释” | 它仍保留特定必要注释，并会把解释内部复杂度的注释转为结构改进线索 |
| “构建和测试全绿，用户问题就一定解决” | 还要回到对应的真实操作路径与产物验证 |
| “多 agent 可以直接共用一个工作目录写代码” | 使用隔离目录、worktree 或云环境，并分配运行资源 |
| “多模型投票可以代替证据” | 要求运行证据，审查被保留和被排除的问题 |
| “`auto` 是一种模型标识” | 它表示继承主聊天模型，不是传给模型接口的真实名称 |
| “`/loop` 来自 pstack，关机也会跑” | 它依赖宿主唤醒和实际执行环境 |
| “Benny 安装插件后就会监听 Slack” | 自动化包默认未启用，需要单独配置和测试 |
| “Claude Code 与 Cursor 的所有能力相同” | 查适配表，确认跳过的能力及模型映射 |
| “形式化检查通过就证明整个系统正确” | 阅读模型假设、检查范围及模型与代码的对应关系 |
| “插件规则可以突破仓库保护路径” | 项目约束与操作授权仍然适用 |

来源：[常见陷阱][S20]、[构建与清理][S11]、[适配说明][S5]、[自动化说明][S19]。最后一项是将插件应用于受约束项目时的工程要求。

无法使用某项能力时，先分清是插件未安装、技能没有附加、模型不可用、缺少外部工具，还是宿主不支持。不要用重复发送“继续”代替查明具体阻碍。

## 9. 如何在当前 AFK 仓库试用？

以下是依据本仓库 `AGENTS.md` 提出的试用建议，不代表已接入平台或改动了现有流程。

### 第一步：做一次只读调查

```text
/poteto-mode 只读调查 packages/shared/src/stage-flow.ts
与 packages/shared/src/finalize-flow.ts，解释它们分别表达的状态流。
引用源码位置，区分确定事实与推断。不修改文件。
```

### 第二步：选一个边界小、能复现的问题

在提示词里说明公开接口、失败现象、验收条件和允许的操作。继续遵守本仓库规范：新行为先写测试，API 测试连接真实 Postgres，避免 mock 自己的模块，不删除、跳过或重命名既有测试。

### 第三步：先验证本地结果，再扩大自主范围

按项目规范运行适用的检查；提交前需要 `pnpm typecheck`、`pnpm test`、`pnpm lint` 全部通过。涉及 API 路由或数据库结构时，也要执行仓库规定的生成步骤。pstack 提供通用流程，项目决定实际验收标准。

首次试用建议显式限制为本地修改和验证。保护路径仍按 `AGENTS.md` 处理，插件不能替人批准对它们的修改。

有两类默认行为尤其需要在本仓库收窄：

- pstack 的测试原则和 `correct` 允许重写或删除被判断为无效的测试；本仓库要求保留既有测试名称，未经批准不得删除、跳过或重命名。清理测试时以仓库要求为准。[测试原则][S22]、[correct][S21]
- 主入口把团队聊天、改票等外部动作列入可自主推进的例子，而 `never-block-on-the-human` 的单独原则文件又把外部消息列入需要确认的动作。对外消息和项目外部记录更新应事先单独写明授权范围，不能依赖两处文字自行推定权限。[主入口][S2]、[自主原则][S23]

### 第四步：逐步沉淀可重复验证

优先考虑把服务启动、测试数据准备、公开接口操作和结果读回沉淀为项目验证能力。对于租约、重试或状态机，可以单独评估形式化检查的价值；先选一条精确性质，再决定工具和检查范围。

**本文对适用边界的判断**：pstack 可以补充本机开发与验证方法；它自身不会因此替代本仓库已有的状态机、持久记录、门禁和执行环境。若要接入平台，应另行设计集成边界，而不是直接把 `/poteto-mode` 当成平台接口。

## 10. 建议的上手顺序

1. 安装，运行 `/setup-pstack`，从较小预算开始观察。
2. 做一次只读调查，确认调用与模型配置正常。
3. 完成一个有明确复现路径的小修复，核对证据质量。
4. 建立或复用项目验证能力。
5. 按需要使用 `arena`、`swarm` 和 `interrogate`。
6. 有了稳定检查和清楚的权限边界后，再尝试长任务、PR 队列或自动化。

这是本文建议的采用顺序。官方学习入口为[十章使用指南](https://github.com/cursor/plugins/tree/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide)。

## 参考来源

全文链接固定到本次查阅的提交，便于以后区分版本变化。需要看最新内容时，从[项目当前主页](https://github.com/cursor/plugins/tree/main/pstack)进入。

- [插件清单与版本][S0]
- [项目 README、技能与原则索引][S1]
- [poteto-mode 主入口][S2]
- [安装与初始化指南][S3]、[setup-pstack 源码][S4]
- [Claude Code 适配说明][S5]、[适配目录][S6]
- [任务路由与提示方式][S7]
- [Bug fix 流程][S8]、[Feature 流程][S18]
- [验证与交付指南][S9]
- [设计、多方案比较与对抗审查][S10]
- [构建与清理指南][S11]
- [定制、纠错与评测指南][S12]
- [Hillclimb 流程][S13]
- [长任务与无人值守指南][S14]
- [决策日志源码][S15]
- [Autopilot-stack][S16]、[Autopilot-full][S17]
- [Benny 自动化包][S19]
- [使用配方与常见陷阱][S20]
- [correct 纠错技能][S21]、[测试原则][S22]、[自主原则][S23]

[S0]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/.cursor-plugin/plugin.json
[S1]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/README.md
[S2]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/poteto-mode/SKILL.md
[S3]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide/01-setup.md
[S4]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/setup-pstack/SKILL.md
[S5]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/harness/claude-code.md
[S6]: https://github.com/cursor/plugins/tree/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/harness
[S7]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide/02-poteto-mode.md
[S8]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/poteto-mode/playbooks/bug-fix.md
[S9]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide/06-verify-and-ship.md
[S10]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide/04-design.md
[S11]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide/05-build-and-clean.md
[S12]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide/09-make-it-yours.md
[S13]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/poteto-mode/playbooks/hillclimb.md
[S14]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide/07-overnight.md
[S15]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/show-me-your-work/SKILL.md
[S16]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/poteto-mode/playbooks/autopilot-stack.md
[S17]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/poteto-mode/playbooks/autopilot-full.md
[S18]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/poteto-mode/playbooks/feature.md
[S19]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/automations/benny/README.md
[S20]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/docs/guide/10-recipes-and-pitfalls.md
[S21]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/correct/SKILL.md
[S22]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/principle-test-behavior-not-implementation/SKILL.md
[S23]: https://github.com/cursor/plugins/blob/e1cc03121a0e71129a4fb730d7c5528a0a3e43c8/pstack/skills/principle-never-block-on-the-human/SKILL.md
