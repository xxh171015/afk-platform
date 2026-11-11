# 阶段：diagnose

这是一次**诊断**运行：联调票的 e2e 失败了，你要查出是哪个仓库的问题。**只诊断，不改任何代码，不要提交。**

你所在的沙箱已经接进联调环境的网络，环境里各仓库的服务是真的在跑，它们的地址在环境变量里（例如 `BACKEND_URL`，以 `env` 命令看到的为准）。

## 先读

1. /context/ticket.md：联调票的验收标准。e2e 要验证的就是它们，以它为准判断谁对谁错
2. /context/failure/gate.log：上一次 e2e 失败的日志，里面有失败的用例
3. /context/spec.md：需求背景。里面的 seams 已经确认
4. /context/contract/<仓库名>/（如果有）：契约，只读，以它为准
5. /refs/<仓库名>/：环境里其他仓库的代码快照，只读，用来读后端怎么实现的
6. 仓库根目录的 AGENTS.md：怎么跑

## 做

- 先复现：在本仓库里运行 e2e（怎么跑看仓库的 `AGENTS.md`），看失败是否还在，再用 curl 之类直接对着环境里的服务发请求，看它们的真实行为。`/context/run.json` 的 `gate` 里有 `setup`，只列出来、不要求你自己再跑。
- 对照验收标准和契约判断：是 e2e 本身（本仓库）写错了或前端用错了接口，还是环境里某个服务的行为不符合验收标准或契约。照验收标准判断，不要因为服务现在这样就认定 e2e 错了。
- 判断不出来、或者两边都有问题时，不要猜：failingRepo 写 `"unknown"`，在 evidence 里写清楚你查到了什么。
- 不要修改任何文件，不要 git commit。只在需要时往 /tmp 里写临时文件。
- 这个阶段不读 skill，只用覆盖层。

## 最后一步：输出结果

结果格式：

```
<result>
{
  "result": "fail",
  "failingRepo": "<出错的仓库名：本仓库、环境里的仓库之一，或 \"unknown\">",
  "evidence": "你查到了什么：请求、响应、读到的代码位置，足够让人和修复票的 agent 直接据此动手",
  "failingTests": ["<失败的用例名>"]
}
</result>
```

- `result` 为 `fail` 表示 e2e 的失败是真的，`failingRepo` 必填。
- 复现时 e2e 全部通过了（失败不再出现，比如环境里的时序问题）：`result` 写 `pass`，`failingRepo` 写 null，`evidence` 写你看到的。
- `failingRepo` 只能是本仓库的名字、环境里的仓库名之一，或 `"unknown"`。
