# Components (Section 11) — implemented in C4

- `ContentMount` (client) — the ONE component that mounts content from
  `htmlPage.code`: injects `code.html` (via `<template>` — embedded scripts
  never auto-run), hoists embedded `<style>` to `<head>` and extracts
  embedded `<script>` for execution, appends `code.css` to `<head>` deduped
  per contentId, executes scripts sequentially after double rAF inside an
  IIFE (Blob URL) with top-level function hoisting (`window.fn = fn =
function…`), isolates CMS-script errors (`gw:script-error`), dispatches
  `gw:content-ready`, and supports `[data-ic-nav-href]` / `ic-navigate` SPA
  navigation with re-init on route change.
- `ScriptSlot` (client) — appends admin-slot scripts (gw bootstrap,
  `headCode`, analytics plugins, JSON-LD) to the real `<head>`/`<body>`
  after hydration, idempotent per slot id; runs before content scripts.
- Shell UI (RSC) — `app/(website)/[[...slug]]/page.tsx` renders bootstrap,
  theme CSS variables, analytics, chrome (reserved-slug objects via
  ContentMount), page content, JSON-LD, body slots; `not-found.tsx` and
  `error.tsx` cover typed 404/500 (no silent notFound masking).

Hard rule: never `dangerouslySetInnerHTML` on user data — only content
authors' `data.html` (and admin slot config) is mounted raw (Section 19).
Decisions: ADR-004.
