# apps/web/src — React SPA source

Conventions for the SPA tree. See root [AGENTS.md](../../../AGENTS.md) for the monorepo
build DAG and TypeScript quirks.

## Entry, routing, and data access

Entry: `src/main.tsx` → [`src/router.tsx`](router.tsx) (React Router v8, `BrowserRouter`).
`RequireAuth` / `RequireCoord` wrap protected routes; unauthenticated →
`/login?return=<path>`. `FirstLoginOfSeasonGate` wraps the router to force re-acceptance
of season T&Cs.

- [`useBlob<T>(path)`](hooks/useBlob.ts) — reads public blobs directly via
  `VITE_BLOB_BASE_URL` (dev proxies `/blob/*` → Azurite). Returns
  `{ data, loading, error, notFound }`.
- [`api.get/post/put/delete`](lib/api.ts) — authenticated `/api/*` fetch wrapper;
  auto-attaches `Authorization: Bearer <token>`.
- [`useAuth.tsx`](hooks/useAuth.tsx) defines the auth context/hook;
  [`AuthProvider.tsx`](components/AuthProvider.tsx) owns token persistence and startup
  refresh. Tokens use `localStorage` keys `bcc_access_token`, `bcc_refresh_token`, and
  `bcc_identity`; [`api.ts`](lib/api.ts) handles single-flight refresh after a 401.

## Roles

`Admin` (all admin pages + writes); `RoundsCoord` (manage rounds + club teams for own
`clubId`, sees `/club` self-service); `Pilot` (read authenticated endpoints, edit own
profile); anon (public blobs only).

## Tests

[apps/web/vitest.config.ts](../vitest.config.ts): `jsdom` + `@testing-library/react`;
aliases `@bccweb/types` to `packages/types/src` (no rebuild needed for web tests).

## Import style (REQUIRED)

Relative TS/TSX imports use `.js` extensions everywhere: `../../lib/api.js`,
`./pages/Home.js`, `./hooks/useAuth.js`. Package imports stay extensionless
(`@bccweb/types`, `@bccweb/schemas`). Match this — the build enforces it.

## components/ — shared UI only

One component per file, **named exports**, tiny prop interfaces, inline `style` objects.
Reuse across pages only; page-specific bits stay in the page.
- `LoadingSpinner.tsx` → `LoadingSpinner` + `ErrorMessage` (the shared loading/error pattern)
- `StatusBadge.tsx` → status-to-color mapping
- `BriefImages.tsx` → authenticated image fetch + object-URL cleanup
- `FirstLoginOfSeasonGate.tsx`, `ErrorBoundary.tsx` → default-exported, router-wrapped app guards

## hooks/ — only two

`useBlob.ts` (public blob fetch) and `useAuth.tsx` (auth provider). **Don't add more**
unless genuinely shared — page-local state/effects live inside the page.

## lib/ — gateways + small utils

`api.ts` (`get/post/put/delete/deleteJson`, `ApiError`, auto token refresh w/ single-flight
lock), `blobClient.ts` (public reader behind `useBlob`), `sanitize.ts` (HTML sanitizer for
sign-to-fly wording), `telemetry.ts` (PII redaction + RUM stub), `terms.ts` (T&Cs version).
**All mutations go through `api.ts`** — except multipart uploads (raw `fetch` + `FormData`:
`pages/rounds/RoundBriefForm.tsx` for brief images, `pages/rounds/components/IgcUploadButton.tsx` for tracklogs).

## public/static/ — vendored legacy PDFs

`apps/web/public/static/` holds vendored legacy public PDFs (BCC Rules, Briefing Aide
Memoire, COVID Risk Assessment, Paragliding SOPs) served at `/static/*.pdf` (Vite copies
`public/` verbatim into `dist/web/`).

## pages/ — route-aligned folders

Folder = route domain (`auth`, `rounds`, `results`, `pilots`, `admin`, `club`; plus top-level
`Home/Profile/Terms/About`). 1:1 with `router.tsx`. Page conventions:
- top-level `useState/useEffect`; helper fns + small nested subcomponents **above** the page
- early-return loading / error / forbidden states
- mutation handlers live in the page file (no shared form layer); inline styles OK

Key pages: `RoundManage.tsx` (~275 — coordinator control-panel shell: loads the round, owns
`runAction`, and composes `RoundManageHeader`, `RoundWorkflowActions`, `RoundMetadataForm`,
`RoundBriefForm` and `RoundTeamsList`), `RoundBrief.tsx` (locked brief viewer + PDF/image),
`PilotProfile.tsx` (view/edit profile). Mutation examples: `CreateRound.tsx` →
`api.post("rounds",…)`; `RegisterForRound.tsx` → `…/register-self`; `PilotProfile.tsx` →
`api.put("pilots/:id",…)`; `SignToFly.tsx` → `…/teams/:teamId/pilots/:place/sign`.
