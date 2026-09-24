<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

<!-- SSOT sync duty section - maintained with the SSOT system (2026-09-24) -->

# Documentation Sync Duty - SSOT (automatic, never wait to be asked)

Every code change, behavior change, or design decision made in AI chat that
touches a feature below MUST update the feature SSOT html under
`_docs/deny/_feature-development-management/` (repo root) in the same change.
If a touched feature has no SSOT file yet, scaffold one first:
`cd app && npm run feature:new -- <feature-name> <group>`.

SSOT update rules: update the file in the same change as the code; log every
decision in section 11 (decision register) with the feature's D-prefix and
today's date; update section 3 (existing capabilities) when behavior changes.
When the change adds a hard rule or gotcha, mirror it as a bullet in this
AGENTS.md section. Do this without the user asking.

| Feature | SSOT html (path under `_docs/deny/_feature-development-management/`) | D-prefix |
|---|---|---|
| Public website rendering (resolver, render plan, ContentMount, ScriptSlot, chrome, data.sections) | `website/page-rendering/page-rendering-ssot.html` | D-PAGE |
| Gateway SDK and widgets (`lib/gw-sdk`, `/gw-widgets.js`) | `sdk/gw-sdk/gw-sdk-ssot.html` | D-GWSD |
| Data and operations API (`/api/data/*`, DataProvider) | `data/data-api/data-api-ssot.html` | D-DAPI |
| Forms (`/api/forms/*`) | `forms/form-submission/form-submission-ssot.html` | D-FORM |
| Flow engine (`/api/flow/*`, `lib/render/flows.ts`) | `flow/flow-engine/flow-engine-ssot.html` | D-FLOW |
| Auth and account (`/api/auth/*`, `/api/account/*`) | `auth/auth-system/auth-system-ssot.html` | D-AUTH |
| Cart (`/api/cart`) | `cart/cart-system/cart-system-ssot.html` | D-CART |
| Payments (`/api/pay/*`, `lib/pay`) | `pay/payments/payments-ssot.html` | D-PAYM |
| Email (`/api/email/*`) | `email/email-service/email-service-ssot.html` | D-EMAI |
| Search (`/api/search`) | `search/search-service/search-service-ssot.html` | D-SRCH |
| Realtime, events and caching (`/api/subscribe`, `lib/events`, `lib/cache`) | `events/realtime-cache/realtime-cache-ssot.html` | D-EVNT |
| SEO and revalidation (`/api/revalidate`, sitemap, robots, llms) | `seo/seo-services/seo-services-ssot.html` | D-SEO |

D-prefixes must stay unique across the whole project - check this table
before creating a new feature file.

Risk levels (governance v1.1): a risk level measures the PRODUCTION
publish/usage impact of the code the risk describes. Documentation-only
concerns are never high/critical; plan-stage risks for unbuilt code are
recalibrated to their real production impact or accepted with the mitigation
recorded in the Last re-evaluation line. Never downgrade a genuine
production/security risk - keep it and record its planned mitigation.

Limits: this duty runs during AI chat work. Changes the user makes by hand
outside a chat are not detected - then a short chat mention ("I changed X")
is enough for the sync to happen.

<!-- SHIP chat command section - copied from the portable kit (v1.1) -->

## SHIP Command - chat command, the AI runs it (not a terminal command)

The user types "SHIP" in this chat and the AI executes the whole release
procedure itself. The user never runs npm in the terminal for this. Run the
npm commands from `app/` (the Next.js project root).

Procedure when the user says SHIP:
1. Run `npm run risks` (read-only) and briefly list the blocking risks
   (critical/high) in the chat: file, risk ID, title.
2. Run the full release in the terminal with a generous timeout:
   `npm run ship` - the complete defined procedure: stage, gate, AI commit
   message, version patch, push with tags, release logs, task stamping,
   control tower index, doc commit.
3. If the gate blocks: "SHIP" is the user's explicit override. Re-run
   `npm run ship -- --force` and continue. Report the blocking risks in the
   final result - the risks stay recorded in their SSOT files. NEVER edit
   risk registers (solve/accept) unless the user explicitly asks.
4. Report the result in chat: commit message used, new version, what got
   stamped, and any warnings or skipped steps.

Variants:
- "SHIP" - run everything, force past the gate if needed, report risks.
- "SHIP STRICT" - strict gate only: if blocked, stop and show the risks,
  ship nothing.
- "SHIP --force" - same as plain SHIP.

Rules:
- SHIP is the ONLY trigger for committing or pushing. Never commit/push in
  any other situation unless the user explicitly asks for it in words.
- If the release fails for a reason OTHER than the gate (AI backend down,
  git error), stop and report the exact error - never improvise workarounds.
- Never print or echo secret values (API keys) - the scripts already avoid it.
