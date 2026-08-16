# Resolvers (Sections 5 / 6 / 7.3) — implemented in C2

- `host.ts` — `normalizeHost` (lowercase, strip port, FQDN dot, IPv6
  brackets) + `hostMatches` (exact or `*.domain` wildcard; the bare domain
  never matches its own wildcard). Pure, edge-safe (imported by `proxy.ts`).
- `tenant.ts` — hostname → `TenantConfig` via the relay-style registry: one
  `settings` doc per hostname (`tenantConfig` object or base64 `config`), read
  through `DataProvider.getSettings`. Falls back to the deployment's default
  tenant (Section 22 env) when the host has no entry. Per-host memory cache
  (`TENANT_CACHE_TTL_MS` = 60 s, negative caching) + `invalidateTenant` hooks
  for the C11 purge work.
- `site.ts` — `resolveSite(host)` per Section 7.3: website-capable apps from
  the `cms-settings` settings doc (`capabilities` includes `'website'`), find
  the object with slug `default-settings` whose `data.hostNames` contains the
  host (exact or wildcard) → its `typeId` is the site folder, its data is the
  site config. App fallback = tenant `defaultAppId`, then the plan default.
  Otherwise notFound — NO content-system fallback. Cache + invalidation hooks
  (`SITE_CACHE_TTL_MS`).
- `index.ts` — lazy singleton wiring (`getResolverStack()`) shared by
  requests; default tenant from the Section 22 env contract.

`page.ts` (C3) — pure, Firestore-free page resolver per Section 9: `parsePath`
(home / slug / `<type>/<id>` / `/t/<template>/<contentId>` / `/app/...` /
not-found), `selectPageObject` (slug + `meta.language` + draft-status rules),
`findSiblings` (same `contentId`, other languages), `resolveLanguage`
(defaultLanguage, no path prefixes). Callers inject a `PageObjectLoader`
wired to the DataProvider (Section 6B). RenderPlan: see `lib/render/`.
Decisions: ADR-002 (C2), ADR-003 (C3).
