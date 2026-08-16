# GeneralWebsite NEXT-GEN

A brand-new Next.js application that serves public websites entirely from the
Uniconhub object-management system — pages are objects whose data part carries
the generated HTML content. No content management, no legacy JSON rendering,
no backward compatibility (except the documented data-field fallback).

**App path:** the Next.js app lives in the `app/` subfolder of this repository
(repo root holds non-app files — `docs/` — so per plan Section 27 the app goes
here). App Router routes are in `app/app/`.

**Single source of truth:** `docs/generalwebsite-nextgen-plan.html` (repo root).
Locked decisions in its header and Sections 1–8, 6B, 22, 27 are binding.

## Stack (Section 4)

- Next.js (latest App Router, Turbopack), React 19
- TypeScript strict — `any` is a lint error
- Zod contracts + env validation (fail fast at boot)
- firebase-admin via the DataProvider abstraction (Section 6B)
- pnpm · ESLint + Prettier · Vitest + Playwright · GitHub Actions CI

## Setup

```sh
pnpm install
cp .env.example .env.local   # env is Zod-validated at boot (Section 22)
```

## Commands

| Command           | What it does                                          |
| ----------------- | ----------------------------------------------------- |
| `pnpm dev`        | Start the dev server (http://localhost:3000)          |
| `pnpm build`      | Production build (requires valid env — see above)     |
| `pnpm start`      | Serve the production build                            |
| `pnpm lint`       | ESLint (Next core-web-vitals + typescript, no `any`)  |
| `pnpm typecheck`  | `tsc --noEmit` (strict)                               |
| `pnpm test`       | Vitest unit tests (contracts, normalize, common core) |
| `pnpm test:watch` | Vitest watch mode                                     |
| `pnpm e2e`        | Playwright smoke (`pnpm exec playwright install` 1st) |
| `pnpm format`     | Prettier write / `pnpm format:check` to verify        |

CI (`.github/workflows/ci.yml`): lint → typecheck → test → build.

## Structure (Section 27)

```
app/              App Router routes (website pipeline arrives in C4)
components/       shell UI, ContentMount, GwBridge (C4)
lib/
  contracts/      Zod schemas for every shape (tenant, app, folder, page,
                  SEO, operation, flow, data query)          ← C1
  config/         env schema (Section 22)                    ← C1
  data/
    provider.ts   DataProvider interface (Section 6B)        ← C1
    common/       shared query/filter/facet/relation core    ← C1
    providers/
      firestore/  Firestore adapter (only firebase code)     ← C1
      supabase/   Supabase adapter (designed-in, later)
  firestore/      firebase-admin app factory (adapter-only)  ← C1
  render/         normalize.ts + render plan, SEO (C3/C4)    ← C1 (normalize)
  resolver/       host/site/page/language (C2/C3)
  gw-sdk/         window.gw SDK v2 (C5)
  cache/          tags + memory cache (C11)
  security/       origin, rate-limit, captcha (C6)
tests/            Vitest unit tests
e2e/              Playwright specs
```

## Hard rules (plan)

- No legacy code copied from the old repo (clean-room).
- Firestore collection names/suffixes and record shapes stay
  Uniconhub-compatible (`om_objects` / `om_private_objects` + table
  extension, `om_object_types`, `settings`) — never fork the data model.
- No content-management reads; content type is ONLY `data.html`
  (the `htmlPage.code.{html,css,js}` html-tool field).
- Secrets env-only; per-tenant env convention (Section 22):
  `<PROJECTID_WITH_UNDERSCORES>_firebase_admin_{project_id,private_key,client_email}`,
  `<TENANT>_STRIPE_{SECRET,WEBHOOK_SECRET,PUBLISHABLE}`.
- All data access through the DataProvider interface (Section 6B) — never the
  Firestore SDK directly from app code.

## Env vars (Section 22 — validated at boot)

`NODE_ENV`, `NEXT_PUBLIC_APP_NAME`, `FIREBASE_PROJECT_ID`,
`FIREBASE_ADMIN_CLIENT_EMAIL`, `FIREBASE_ADMIN_PRIVATE_KEY`, `RELAY_SECRET`,
`FORMS_RATE_LIMIT_MAX`, `FORMS_RATE_LIMIT_WINDOW_MS`, `REVALIDATE_SECRET`
(required) — `RECAPTCHA_SITE_KEY`, `RECAPTCHA_SECRET_KEY`,
`SES_ACCESS_KEY_ID`, `SES_SECRET_ACCESS_KEY`, `SES_REGION`,
`INDEXNOW_API_KEY`, `SENTRY_DSN` (feature-gated, optional). See
`.env.example`.
