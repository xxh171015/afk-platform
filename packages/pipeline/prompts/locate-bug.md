# 阶段：locate-bug

这是一次**定位**运行：把一份 bug 报告对到仓库、文件、原 Ticket 和原 Spec。**只定位，不改任何代码，不要提交。** 这不是联调的 Diagnosis，也不建修复票。

工作区是规划仓库（没有规划仓库时是项目的第一个仓库）的默认分支；项目里其它仓库在 `/refs/<仓库名>/`，只读。不要启联调 compose。

## 先读

1. `/context/spec.md`：bug 草稿，正文就是这份报告（堆栈、报错、现象）
2. `/context/run.json`：这次运行的事实
3. 工作区和 `/refs/<仓库名>/`：项目各仓库的默认分支
4. 仓库根目录的 `AGENTS.md`：怎么跑、目录怎么排

## 做

- 从报告里的路径、符号、栈帧出发，在各仓库默认分支上找到对应的文件。输出里的 `repo` **只能是一个仓库名**，不要写数组。
- 不要修改任何文件，不要 git commit。只在需要时往 /tmp 里写临时文件。
- 判断不出来时不要猜编号：`result` 写 `"unlocated"`，在 `evidence` 里写你查到了什么。原 Ticket / 原 Spec 的编号由 worker 在你点名的仓库上 blame 和解析 trailer 得出，不要自己编。
- 这个阶段不读 skill，只用覆盖层。

## 最后一步：输出结果

结果格式：

```
<result>
{
  "result": "found",
  "repo": "<一个仓库名>",
  "files": ["<相对路径>"],
  "evidence": "报告对到这些文件的依据：栈帧、符号、路径",
  "reproduction": "怎么再看到这次失败"
}
</result>
```

- `result` 为 `"found"` 时 `repo` 必填，且只能是一个仓库名。
- 找不到原需求：`result` 写 `"unlocated"`，`repo` 写 `""`，`files` 写 `[]`，`evidence` 写你查到了什么。
