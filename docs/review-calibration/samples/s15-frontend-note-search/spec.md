# 订单列表备注搜索

## Problem Statement

运营在订单列表里需要根据**备注**里的关键词快速找到相关订单。今天列表接口不支持按备注筛选，列表页也没有搜索入口；备注只在订单详情里可见，无法在列表侧按内容检索。

## Solution

在订单列表查询上增加可选的**备注关键词**过滤：服务端按备注字段做子串匹配，与现有客户、状态等条件一起生效；列表页提供备注搜索框（输入防抖后请求），并在表格中展示备注（过长时截断，悬停可看全文）。领域用语与 glossary 一致：**备注**对应 API 字段 `note`。

## User Stories

1. As an operator, I want to type a keyword on the order list, so that I only see orders whose note contains that text.
2. As an operator, I want the search to run automatically after I pause typing, so that I do not have to click a separate search button.
3. As an operator, I want leading and trailing spaces in the search box ignored, so that accidental spaces do not change results.
4. As an operator, I want an empty search box to show all orders again, so that I can clear the filter without reloading the page.
5. As an operator, I want to see a note column on the list, so that I can tell why an order matched my search.
6. As an operator, I want long notes truncated in the table with the full text available on hover, so that the layout stays readable.
7. As an operator, I want orders without a note to disappear from results when I search a non-empty keyword, so that search means “has note matching text”.
8. As an operator, I want note search combined with existing list filters (customer, status, sort, limit, offset), so that I can narrow results further when those parameters are used.
9. As an operator, I want the total count in the list response to reflect note filtering, so that pagination and counts stay trustworthy.
10. As an operator, I want note matching to respect letter case, so that behavior is predictable and consistent with customer name filtering.
11. As an operator, I want invalid search input rejected with a clear error, so that I know when my query is too long or empty as a parameter.
12. As an API consumer, I want a documented optional `note` query parameter on list orders, so that clients besides the pilot UI can filter by note.
13. As an operator, I want list search to stay limited to note only (not new customer or status controls on this page), so that scope stays focused.
14. As a maintainer, I want contract tests to cover a successful list request that uses the note parameter, so that the published API stays aligned with the contract.
15. As a maintainer, I want behavioral tests for empty note parameter, overlong note parameter, substring match, case sensitivity, and combination with customer filter, so that regressions are caught early.

## Implementation Decisions

- **Contract**: Extend `GET /orders` with optional query parameter `note`, string, `minLength` 1, `maxLength` 200. Omitted parameter means no note-based filter. Empty string value returns 400 with `{ "error": "note must not be empty" }`. Value longer than 200 characters returns 400 with `{ "error": "note must be at most 200 characters" }` (same cap as order note field).
- **Filtering semantics**: When `note` is present, keep orders whose `note` property exists and contains the query string as a contiguous substring. Matching is case-sensitive. Orders with no `note` property do not match any non-empty filter. No feature to list “orders without a note”.
- **Composition**: Apply note filter together with existing customer, status, sort, limit, and offset behavior using logical AND for filters. `count` is the number of orders matching all active filters before limit/offset slicing (same as today for customer/status).
- **Backend parsing**: Add validation parallel to existing list query parsers; map validation failures to HTTP 400 and `{ "error": "<message>" }`.
- **Frontend list UI**: Add a labeled search control for 备注 on the order list. Trim input before building the request; if trim yields empty string, call list orders without `note`. Debounce refetch approximately 300 milliseconds after input changes. Pass `note` as query parameter on the typed API client GET.
- **Frontend table**: Add a 备注 column. Display empty cell when order has no note. When note text exceeds about 30 characters, show a truncated preview with ellipsis and expose full text via native `title` tooltip (or equivalent accessible full text).
- **Glossary**: Term **备注** is defined in project glossary as optional explanatory text on an order; this spec does not redefine it.
- **Repositories**: Contract change in backend repo; implementation tickets expected for backend list handler and frontend list page. Frontend contract copy and generated types follow the usual ticket-with-contract flow when a contract ticket lands.
- **Out of scope for implementation tickets derived here**: Customer or status filter UI on the list, case-insensitive search, full-text or fuzzy search, searching status history text, indexing or persistence beyond current in-memory store.

## Testing Decisions

- **What makes a good test**: Assert HTTP status, JSON bodies, and user-visible UI text/roles only— not internal store layout or private parser function names unless an existing suite already tests a pure parser in isolation for list query params (follow existing precedent for customer filter).
- **Seams**:
  - **Backend — primary seam**: End-to-end HTTP tests through `startApp()` exercising `GET /orders` with `note` and combinations (mirrors existing list filter tests for customer and status). This is the highest seam that proves filtering, count, pagination interaction, and error responses.
  - **Backend — contract seam**: One conforming list request including `note` in the contract test suite alongside existing operation coverage.
  - **Backend — OpenAPI seam**: Extend existing OpenAPI structure tests so the list operation documents `note` with the same constraints as the decision above (parallel to how optional list parameters are asserted today).
  - **Frontend — primary seam**: `OrderList` component tests with MSW handlers that record or respond to `GET /orders` query strings; assert debounced refetch, trim/clear behavior, error alert, note column rendering, and truncation/tooltip behavior. Prior art: existing OrderList tests for loading, errors, batch ship, and checkboxes.
- **Not proposed**: New e2e in integration compose for this feature unless a ticket explicitly expands scope; unit tests on the list component’s debounce timer implementation details alone.

## Out of Scope

- UI filters for customer or status on the order list.
- Case-insensitive or locale-aware note matching.
- Finding orders that have no note via a special query value.
- Searching notes from cancelled-order rules beyond existing list contents (list behavior unchanged except note filter).
- Changing note max length on create/patch.
- Performance work for large datasets (still in-memory pilot).

## Further Notes

- Planning from grill-with-docs: ADR not required; decisions are reversible and straightforward.
- `GLOSSARY.md` entry for **备注** should ride along with `plat spec confirm` on the backend repo integration branch (already drafted locally during grill).
- Seed data includes sample notes; frontend e2e that references seed customers is unchanged unless a future ticket adds list search e2e.

