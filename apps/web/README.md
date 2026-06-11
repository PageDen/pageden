# @pageden/web

Pageden web app — Vite + React + TypeScript + Tailwind + shadcn-style UI, routed with
TanStack Router and server-state via TanStack Query. SPA (client loaders), per the M3 plan.

## Dev

```bash
pnpm --filter @pageden/web dev   # http://localhost:3000, proxies /api → :4000
```

Set `API_PROXY_TARGET` to point the dev proxy elsewhere. The client base URL is
`VITE_API_BASE_URL` (defaults to `/api`, same-origin via the proxy, so the `pm_session`
cookie stays first-party).

## What's here (PR 1 — scaffold + auth)

- Typed `api-client` (`src/lib/api.ts`) with `credentials: include`, a structured `ApiError`,
  and response validation against the `@pageden/api-types` zod schemas.
- Auth: `/login`, a pathless guard that requires `GET /me` (redirects to `/login` otherwise),
  logout, and an empty workspace shell with the permission-filtered tree wired to
  `GET /documents/tree`.
- `useDocumentDraft` (`src/lib/draft.ts`): the editor draft / `baseVersion` ownership
  abstraction + LF canonicalization, ready for the editor PR.

Later PRs add the document editor + conflict UX, admin screens, and Playwright E2E.
