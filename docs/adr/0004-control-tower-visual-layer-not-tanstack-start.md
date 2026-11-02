# 控制塔视觉层搬进 packages/web，不搬 TanStack Start

操作体验要对齐冻结原型正在渲染的路由（一对一），页面继续 Vite SPA、只依赖 `shared`、打 Hono。所以把原型的设计 token、`app-shell`、实际用到的 afk 组件和产品代码真正 import 的 shadcn 搬进 `packages/web`；不引入 TanStack Start，不搬 mock 应用和其余 `components/ui`。

## Considered Options

- **把 Lovable 的 TanStack Start 工程换成 `packages/web`**：和 [issue 134](https://github.com/xxh171015/afk-platform/issues/134) 相反，页面不再只依赖 `shared`、不再打本机 Hono。
- **只按信息架构重画、不搬原型视觉代码**：`packages/web` 已经证明会停在 M1 疏排，一对一对不上。
- **整包搬 46 个 shadcn `components/ui`**：原型产品代码只用约 13 个。

## Consequences

- [issue 126](https://github.com/xxh171015/afk-platform/issues/126)「不把 Lovable 代码搬进来」收窄为：不搬 Start / mock / 未引用的 ui；视觉层要搬。
- 改正文和 Retry note 仍在页面上，允许这两处不像原型。
