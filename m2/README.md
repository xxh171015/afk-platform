# M2 联调环境原型（PROTOTYPE，不合并）

wayfinder「联调环境原型在 Mac 上跑通」（xxh171015/afk-platform#70）的一次性原型。问题：worker 能不能为后端起一个 compose 环境，让前端的 Sandcastle 沙箱加入它的网络、只读挂上 `/context` 和后端快照 `/refs/afk-pilot-backend`，再让真实的 Cursor agent 跑 e2e、输出联调结构化结果？

```sh
# 在 Mac 上（~/afk-m2-proto：本目录的文件 + work/backend.git、work/frontend.git 两个从 bundle 克隆的 bare 仓库）
bash mac-proto.sh checks      # #64 留下的 7 项 Docker 实测，不跑 agent
bash mac-proto.sh run         # 一次联调，后端正常
bash mac-proto.sh run --bug   # 一次联调，后端的状态记录倒序返回
```

实测输出在 `results/`（2026-10-30，Docker 28.2.2，macOS，Cursor `auto`，试点 backend `4b99a7f`、frontend `c5407e5`）。结论见 issue #70 的评论。
