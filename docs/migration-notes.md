# Migration Notes — Legacy → GeneralWebsite NEXT-GEN (M11)

Status: **documented, not executed** — the cutover of real production sites is
an operational task that happens per tenant; no legacy instance is attached to
this repository. This file is the migration runbook: mapping, tooling plan,
retire order. (Recorded in CHECKLIST.md per the C13 hard rule: pilots must not
pretend a real cutover happened.)

## 1. Concept mapping (legacy → NEXT-GEN)

| Legacy | NEXT-GEN |
|--------|----------|
| `MainPageSSR.js` page render | `app/(website)/[[...slug]]/page.tsx` + resolver + RenderPlan |
| `data/html-code` blocks, Nunjucks pages | `data.htmlPage.code.{html,css,js}` (data.html semantics) |
| `productData.data_categoriesBased` | `data` (normalization falls back to legacy field — Section 6/8) |
| `html-code` / `InjectedContent.js` | ContentMount (`components/content-mount`) |
| `utils/firebaseSettings.js` host → project | cached tenant resolver (`lib/resolver`) |
| `api/relay/ras` | `/api/relay/ras` (same contract) |
| `pages/*.xml.js` sitemap/robots | `/sitemap.xml`, `/robots.txt`, `/llms.txt` (host-driven) |
| `HeadAndMetaData.js` / `jsonLdUtils.js` | `seo` section + JSON-LD builder (Section 16) |
| `DynamicForm.js` / `forms.js` | `gw.forms` + `/api/forms/submit` (+ multipart upload) |
| `api/pay/stripe` | `/api/pay/stripe/*` (PaymentIntents + webhooks) |
| `api/email/sendEmail` | `/api/email/send` (AWS SES) |
| `EndUserRegistration.js` / `p/user/*` | `/p/user/[action]` + `/api/auth/session` (HttpOnly cookies) |
| `components/external/*` analytics | `default-settings.plugins` (site-wide) |
| `contentUtils.js` object query lists | `gw.db.query` + server item templates |
| `dynamicFunctions.js` / `contextFunctions.js` | operations engine formulas + sandboxed context functions |
| `pages/products`, `pages/product` | object-type pages + templates (Section 24) |
| `pages/payment/*` cart | server cart + checkout flow (PART B) |
| `FileUpload.js` | multipart upload endpoint (Section 14) |
| `aggregatedObjectList.js` | query API relations/aggregations (Section 29) |
| `Settings.js` money | folder `currency` + `gw.formatCurrency` |
| `pages/404`, `TenantNotFound.js` | `not-found.tsx` / `error.tsx` |
| `next-pwa`, `api/manifest` | manifest route + serwist (per-domain runtime manifest) |
| `?cms-preview=1` | token-based preview (`gw-preview` + previewSecret) |
| localStorage auth | HttpOnly session cookie (5 days, SameSite=Lax) |
| `utils/trafficManagement.js` | typed middleware rules (same shape) |

## 2. Data migration checklist (per site)

1. Export objects for the website folder from Firestore (legacy `productData`
   is read transparently — normalization fallback — so content can migrate
   lazily; no forced rewrite).
2. Create/verify `default-settings` (hostNames, primaryHost, theme,
   head/body codes, plugins) and `default-header` / `default-footer`.
3. Verify app registration in `cms-settings.objectTypes[]` (website
   capability + publicAccess for public object types + optional
   `webSettings.sitemapSettings.addObjectsToSitemap`).
4. Cut pages over one at a time; pages render from `data.html` — anything
   still block-based must be re-authored (block rendering is dropped by
   decision, Section 2B verdict).
5. Recreate writes: every legacy write path (form save, cart, booking)
   becomes a CMS-defined operation or a flow definition — NO raw client
   writes exist in NEXT-GEN.
6. Re-key secrets: REVALIDATE_SECRET, RELAY_SECRET, reCAPTCHA, SES, Stripe,
   IndexNow — never copy legacy env wholesale.

## 3. Cutover order (recommended)

1. Deploy NEXT-GEN behind the same hostnames with `?gw-preview=<secret>` for
   the CMS team.
2. Shadow: serve NEXT-GEN for preview traffic, legacy for public traffic.
3. Flip the tenant registry (relay/ras) to the new app id per site.
4. Purge CDN tags (`/api/revalidate` with `site-<folderId>` + `host-<host>`).
5. Retire the legacy renderer for that folder only after 72 h of parity
   monitoring (logs: `lib/log/logger.ts`, request latency + status).

## 4. Retire legacy

- Remove per-folder legacy routing entries; keep Firestore data (it IS the
  content store).
- After all folders migrate: drop `pages/*`, `components/external/*`,
  `utils/firebaseSettings.js`, `MainPageSSR.js` from the old app.
- Keep `api/relay/ras` compatibility shim until the admin tools switch.
