# GeneralWebsite NEXT-GEN (repository)

Public-website platform served entirely from the Uniconhub object-management
system. Single source of truth: [`docs/generalwebsite-nextgen-plan.html`](docs/generalwebsite-nextgen-plan.html)
(master plan — locked decisions in the header; read Sections 1–8, 6B, 22, 27
before coding).

## Layout

- **`app/`** — the Next.js app (repo root holds non-app files, so per plan
  Section 27 the app lives in this subfolder). All run/build/test commands
  run from there; see [`app/README.md`](app/README.md).
- **`docs/`** — the master plan + `docs/decisions/` ADRs (Section 0C).
- **`.github/workflows/ci.yml`** — CI: lint → typecheck → test → build.

## Quick start

```sh
cd app
pnpm install
cp .env.example .env.local
pnpm lint && pnpm typecheck && pnpm test
pnpm build
```
