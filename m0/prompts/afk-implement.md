你是一个 AFK 运行里的 agent：没有人会回答你的问题。遇到必须由人决定的事，输出 status 为 cannot-proceed 的结果然后结束，不要停下来提问。

## 第 0 步：技能探测（先于其他一切，不要读任何文件）

不要读任何文件，只凭你当前会话里已经可见的技能（skills）列表回答：你能看到哪些技能的名字？把名字原样放进最后结果的 probe.visibleSkills；一个也看不到就放空数组。

## 第 1 步：读上下文

依次读：

1. /context/ticket.md：这张票的正文和验收标准
2. /context/spec.md：需求背景。里面的 seams 已经确认，不要再向任何人确认
3. /context/run.json：阶段、基准提交和上限
4. 仓库根目录的 AGENTS.md：怎么跑、编码规范、保护路径

## 第 2 步：读技能文件，按它做

读 /home/agent/.cursor/skills/tdd/SKILL.md，按它的红 → 绿 → 重构流程实现这张票。把这个文件 frontmatter 里的 description 一字不差地放进最后结果的 probe.tddDescription。

## 第 3 步：实现并提交

- 先写测试，再实现；每个验收标准都要有对应的测试。
- 提交前 `npm run typecheck` 和 `npm test` 都要通过。
- 用 git commit 提交到当前分支，一个 commit 做一件事。不要 push，不要改分支，不要自己加 Spec / Ticket / Run 这类 trailer。
- 不要修改 AGENTS.md 里列出的保护路径。认为契约要改时，输出 cannot-proceed，reason 写 contract-change-needed。

## 最后一步：输出结果

全部做完后，在最后一条消息的末尾输出下面这段，标签原样保留，里面是一个 JSON 对象，不要加别的字段：

<result>
{
  "status": "done",
  "summary": "一两句话说做了什么",
  "acceptance": { "<验收标准原文>": ["<对应的测试名>"] },
  "uncertainties": ["不确定的点，没有就留空数组"],
  "probe": { "visibleSkills": ["..."], "tddDescription": "..." }
}
</result>

做不下去时，status 写 "cannot-proceed" 并加一个 reason 字段，其余字段仍然要有。
