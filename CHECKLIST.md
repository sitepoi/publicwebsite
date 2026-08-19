# GeneralWebsite NEXT-GEN — Feature Parity Checklist (Section 2B sign-off)

Per-row status of the legacy → NEXT-GEN feature audit, recorded as required by
STEP C13 (Section 0C / 2B). Statuses: ✅ implemented & verified · 🔶 partial /
planned path · ❌ dropped by decision.

| # | Legacy feature | Status | Notes / evidence |
|---|----------------|--------|------------------|
| 1 | Multi-tenant hostname → tenant/Firebase config | ✅ | Cached server module + route (Section 6); fixture + Firestore tenants verified |
| 2 | Client Firestore coupling / Supabase switch | ✅ | DataProvider abstraction, per-tenant backend (Section 6B); firestore + supabase + fixtures adapters |
| 3 | Page by slug · 11 locales · hreflang · lang switcher | ✅ | Sections 8–9; resolver language matching + siblings/hreflang tests |
| 4 | Object pages `/<type>/<id>` | ✅ | Section 24 object-detail pages (`/menu-items/menu-1` e2e) |
| 5 | Template pages `/t/<template>/<contentId>` | ✅ | **M8 closed in C13** — content object can carry its own `data.html` (`data.templateContentType`); pilot B uses `/t/bus/trip-101` |
| 6 | Nunjucks templating + filters | ❌ | Dropped 2026-08-18 (C14/ADR-014) — list widget + native template pages replace it; no server-side templating |
| 7 | Raw HTML + JS execution (`html-code`) | ✅ | `data.html` via ContentMount (Section 11) |
| 8 | Per-block css / settingsJSON / cssClassNames | ❌ | Dropped by decision — replaced by `data.css` + embedded `<style>` |
| 9 | Site css-variables / css-classes + `/api/css` stylesheet | ✅ | `default-settings.theme` + site stylesheet route (Section 7.4) |
| 10 | Global head/body additions (pixels, scripts) | ✅ | `default-settings` headCode / bodyStartCode / bodyEndCode |
| 11 | SEO meta + auto JSON-LD (WebPage/BlogPosting/Product/FAQ/Organization) | ✅ | Section 16; JSON-LD from `seo.schemaItems` |
| 12 | Sitemap / robots / feed.xml / llms.txt / IndexNow | ✅ | **M4 closed in C13** — `/sitemap.xml`, `/robots.txt`, `/llms.txt` (host-driven, per-folder config) + IndexNow ping on revalidate. **Follow-up:** `feed.xml` not yet built |
| 13 | CDN cache (72 h) + tagged purge + revalidate webhook | ✅ | Section 18; tag vocabulary + `x-revalidate-secret` |
| 14 | Forms: validation, formulas, file upload, after-save hooks | ✅ | `gw.forms` + operations engine (Sections 14, 30) |
| 15 | Payments: Stripe charge + invoice payment | ✅ | Section 15 — PaymentIntents + webhooks; flow engine PaymentIntent stub mocks it in pilots |
| 16 | Email (AWS SES, form/registration templates) | ✅ | Section 15 |
| 17 | End-user registration + login/logout/reset pages | ✅ | Section 17 first-party pages + HttpOnly session cookies |
| 18 | Analytics plugins: GA4 gtag, Google Tag, Meta Pixel, ShareThis | ✅ | Folder chrome plugins config (site-wide) |
| 19 | PWA manifest + service worker | ✅ | Manifest route + serwist (per-domain runtime manifest) |
| 20 | Scroll/parallax/sticky hooks + `.block-effect-*` | ❌ | Dropped by decision — content authors use their own JS/CSS in `data.html` |
| 21 | Bot / traffic blocking | ✅ | Middleware (same rules, typed) |
| 22 | Object query lists (`object-query-list`) | ✅ | `gw.db.query` + built-in `list` widget (C14 — textContent-safe, subscribe refresh) |
| 23 | Shared content / i18n JSON blocks | ✅ | Reusable sections via `data.sections` (C14) — flat, ordered composition of shared objects |
| 24 | Formulas / context functions (user-defined JS) | ✅ | Operations engine + sandboxed reviewed runtime (Section 30) |
| 25 | Product listing + detail pages | ✅ | Object-type pages + templates (Section 24) |
| 26 | Shopping cart + invoice payment pages | ✅ | PART B server cart + checkout flow (pilot A exercises it end-to-end) |
| 27 | File upload (drag & drop) | ✅ | Multipart upload endpoint (Section 14) |
| 28 | Fuse.js search | ✅ | `/api/search` (Section 15); pilot B search page uses it |
| 29 | Aggregated object lists | 🔶 | Covered by query API relations/aggregations (Section 29) |
| 30 | Money settings / currency formatting | 🔶 | Folder config currency + `gw.formatCurrency` |
| 31 | 404 / 500 / tenant-not-found pages | ✅ | `not-found.tsx` / `error.tsx` |
| 32 | SPA deep links (`data-ic-nav-href`, `ic-navigate`) | ✅ | ContentMount + `gw.navigate` (same event contract) |
| 33 | Per-page header/footer overrides | 🔶 | Page data field `chromeOverride` (planned) |
| 34 | `?showheader=` / `?showfooter=` query params | ❌ | Dropped — chrome controlled by folder/page config |
| 35 | Preview mode (`?cms-preview=1`) | 🔶 | Token-based preview (Section 28 Q9) |
| 36 | Product data feeds (`p/product-list-files`) | 🔶 | Optional data-feed routes later |

## C13 pilot sign-off

- **Pilot A — restaurant ordering**: ✅ verified end-to-end in the emulator
  (`e2e/pilots.spec.ts`): menu/cart widgets → checkout flow (cart → delivery →
  payment with amount formula) → create-order operation (transaction) →
  order-status widget shows the created order. Payment mocked via the flow
  engine stub.
- **Pilot B — bus tickets**: ✅ verified end-to-end: trips objects, search
  page (`search-box` + `gw.db.query`), seat-map (booked seat disabled),
  ticket-checkout flow (seats → passengers → payment, per-seat price formula
  `seats.count * 25`), issue-ticket operation, PNR page listing the issued
  ticket.

## Platform gaps found during C13 (logged per the hard rule)

1. **Session-derived actors** — flow/operation routes defaulted anonymous
   callers to `roles: []`, so authenticated `roles: ['customer']` operations
   could never run from a session. Closed generically in
   `lib/auth/index.ts` (`resolveSessionActor` + `SESSION_COOKIE` shared
   constant) — a platform bug fix, not vertical logic.
2. **Fixture transactions** — the dev fixture provider threw on
   `runTransaction`; transaction-backed operations (both pilots) need it in
   the emulator. Implemented as an in-memory staging adapter (dev facility
   parity only).
3. **`feed.xml`** — not built (follow-up; sitemap/robots/llms/IndexNow are).
4. **Per-page chrome overrides + product data feeds** — remain 🔶 as planned
   in the master plan; no pilot needed them.
