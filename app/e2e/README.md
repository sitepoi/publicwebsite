# e2e (Playwright — Section 21)

Per-representative-site smokes arrive with the website pipeline (C4+):
page renders, scripts execute, form submits, SPA navigation, mobile
viewports 320/375/768/1024.

Run locally:

```sh
pnpm exec playwright install chromium
pnpm e2e
```

The CI skeleton currently runs lint → typecheck → test → build (Section 4);
e2e is wired into CI in a later step.
