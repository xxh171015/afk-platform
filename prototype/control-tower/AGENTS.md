<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

## Architecture rules
- All API types live in `src/api/types.ts`; `src/api/client.ts` mirrors the real HTTP endpoints and is the only file to change when swapping the in-memory mock (`src/api/mock/`) for the real backend.
- Pages fetch with client-side `useQuery` (no route loaders) because the mock state lives in browser memory; SSR would read a separate copy.
- Polling: lists 5s, details 3s via `src/api/queries.ts`; mutations go through its `useAction` hooks, which invalidate specs/blocked/tickets.
- Spec/Ticket badges use the pure status text helpers in `src/lib/view-map.ts`, with original codes in titles; reason/stage codes remain monospace with Chinese meanings from `src/lib/labels.ts`, preserving operational identifiers. Status colors remain `--state-*` tokens.
- No "create" UI: specs/tickets are created and edited via the `plat` CLI.
- Spec detail consumes one spec DTO including runs, agent time and import warnings; ticket criteria live in API types so detail views do not invent operational data.
- Dependency graphs use Dagre ranks projected into repository lanes with fixed node dimensions; graph helpers stay pure for deterministic layout tests.
- Spec sections are nested file routes beneath an Outlet layout; ticket/graph filters and other detail filters stay in URL search parameters, preserving shareable section URLs and filter state.
- Acceptance reports and Markdown exports share pure report helpers and repository DTOs; approved protected paths retain audit history independently from pending approvals.
- Waiting cards and ticket detail use one BlockedTicketActions component so destructive confirmations and retry restrictions stay identical.
- Waiting cards and ticket headers share StructuredBrief rendered from pure view-map projections; ticket run tables link to standalone Run details instead of embedding full logs, keeping evidence and navigation consistent.
- Run logs use offset-keyed Query reads with a tested append/reset reducer; ANSI is rendered as React text spans, never injected HTML.
- Ticket metadata and integration attempts come from the ticket DTO; missing review axes fall back to source/kind categories rather than inferred axes.
- Global search uses the search DTO's optional exact-jump target; Run jumps navigate first to the standalone Run route, and localStorage stores only validated recent-visit labels and destinations.
- Dates and durations use shared time helpers; relative dates refresh client-side and expose absolute UTC timestamps without SSR hydration mismatch.
- Shell owns global shortcuts and waiting-title updates; badges detect semantic value changes locally, with reduced-motion-safe feedback.
- The workbench assembles existing API detail DTOs and renders only the pure `buildWorkbench` projection, keeping quadrant classification independently testable and avoiding a mock-only endpoint.
- Spec pipeline, anomaly banners, ETA copy, and the closed timeline allowlist use pure view-map helpers; timeline DTOs extend existing mock details rather than introducing an unagreed endpoint.
- Run details use a dedicated API DTO and query; shared log viewers classify buffered lines through view-map and retain collapsed raw events, preserving offset polling and safe text-only ANSI rendering.
