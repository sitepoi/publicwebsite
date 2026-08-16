# window.gw SDK v2 (Section 12) — implemented in C5

Isomorphic: no `window` access at import time. The runtime is
`installGwSdk(context)` in `runtime.ts` — fully self-contained (no runtime
imports), serialized verbatim via `Function#toString()` by `bootstrap.ts`
together with the DOMPurify UMD factory, and injected through `ScriptSlot`
BEFORE any content scripts.

## Surface

- Context: `gw.pageId · siteId · folderId · language · host · currency`
- `gw.getPageParams()` → `{ ...query, ...pathParams }` (+ live URL params)
- `gw.navigate(path)` (emits `ic-navigate` → Next router) · `gw.openUrl` ·
  `gw.onRouteChange(cb)` (popstate + navigate)
- `gw.getUser()/isAuthenticated()/login/logout` — C9 stubs (documented)
- `gw.storage` — host-scoped (`gw:v1:<host>:local:<key>` in localStorage) +
  `gw.storage.session` (sessionStorage); failures ignored (private mode)
- `gw.track(event, data)` / `gw.trackPageView()` — gtag + dataLayer + fbq,
  all guarded (optional analytics)
- `gw.notify(msg, {severity,duration,title})` · `gw.showModal(html, opts)`
  (returns close fn) · `gw.setLoading(bool)` — Tailwind-styled DOM bridge;
  message text is never innerHTML
- `gw.sanitize(html)` — DOMPurify (stringified into the bootstrap) with an
  escaping fallback
- `gw.formatDate(value, locale?)` / `gw.formatCurrency(amount, currency?)`
  via `Intl`
- `gw.forms` — Section 14 client:
  `submit(form, {formTypeId})` → `POST /api/forms/submit` (server in C6).
  Files → multipart `FormData`; otherwise JSON
  `{ formTypeId?, submittedAt, gw_hp, values }`. Events:
  `gw:form-success {form,data}` · `gw:form-error {form,error,status?}` ·
  `gw:form-invalid {form,errors}`. Honeypot (`gw_hp`/`website`/`company` or
  `[data-gw-honeypot]`) filled → silently dropped. Busy states (`.gw-busy`,
  buttons disabled) + `[data-gw-form-status]` text.
  `bind(root?)` wires `form[data-gw-form], form.gw-form` (idempotent).
- `gw.db` — Section 29 client twins (server endpoints in C7): `query` →
  `POST /api/data/query`, `get` → `GET /api/data/{type}/{id}` (404 → null),
  `operation` → `POST /api/data/op {operation, payload}`,
  `subscribe` — stub until C11 (warns once).
- `gw.apps` — Section 35 stubs (full in C12): `register(name, factory)`,
  `mount(root?)` → `[data-gw-app]` + `data-gw-config` JSON → factory
  `{ el, config, gw }`; unknown app → `gw:app-error`.
- `gw.service(name)` — server-validated services stub (C6+/M9).

Hard rules honored: no window at import time · storage keyed per hostname ·
no secrets · writes only through `gw.forms`/`gw.db.operation`.

Bootstrap lifecycle: installs on every page, merges into any existing
`window.gw`, dispatches `gw:ready`.
