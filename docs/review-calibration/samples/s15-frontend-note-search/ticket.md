# 订单列表备注搜索与备注列


## Parent

S-15

## What to build

在订单列表页增加**备注**搜索：输入 trim 后为空则不带 `note` 查询参数；非空则在约 300ms 防抖后带 `note` 重新请求列表。表格增加备注列，无备注留空，过长约 30 字截断并以 title 等方式展示全文。不增加客户或状态筛选控件。同步契约副本并重新生成 API 类型。每条验收标准有组件测试（MSW）。

## Acceptance criteria

- [ ] 列表页有备注搜索控件；输入防抖后 GET /orders 携带 trim 后的 note 查询参数
- [ ] 搜索框 trim 后为空时请求不带 note，展示全部订单（与未搜索一致）
- [ ] 表格有备注列；有 note 的订单显示内容，无 note 显示为空
- [ ] 超过约 30 字的备注在单元格截断显示，完整内容可通过 title（或同等可访问方式）查看
- [ ] 列表接口返回 400 时展示后端 error 信息（role=alert）
- [ ] contract/openapi.yaml 与契约票一致，npm run contract:check 与 npm run gen 产物已更新
- [ ] 每条验收标准都有 OrderList 相关组件测试且门禁通过

