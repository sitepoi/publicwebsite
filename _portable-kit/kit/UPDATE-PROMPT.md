# Update prompt - bring an ALREADY-INSTALLED kit up to the latest version

Place the new `_portable-kit` folder at the target project's root (replacing
the older one), then paste the prompt below into that project's AI chat.

---

## THE PROMPT (copy everything below this line)

Update the installed SSOT system in this project to the latest portable kit
version. The new kit is at `_portable-kit/` (it replaces the older one).

Step 1 - READ first:
- `_portable-kit/kit/KIT-VERSION.md` - what changed between versions.
- `_portable-kit/_ssot-system-portable-guide.html` - the full reference; it
  is the source of truth for every detail.

Step 2 - APPLY the changes:
- Template name: ensure
  `_docs/deny/_feature-development-management/_template/_ssot-template.html`
  is the ONLY feature template name. If an older `_feature-template.html`
  exists there, delete/rename it and update every script and doc reference
  to `_ssot-template.html`.
- Scripts: copy all files from `_portable-kit/kit/scripts/` over this
  project's `scripts/` (new: `ssot-risks.js`; updated: `release.js` with the
  `--force` flag and the risks-report message).
- npm scripts: add/update in `package.json`: `ship`, `SHIP`, `risks` (see
  `_portable-kit/kit/package-json-scripts.json`).
- SHIP chat command: copy the section from `_portable-kit/kit/SHIP-COMMAND.md`
  into this project's `copilot-instructions.md` (or this project's
  AI-instructions convention), so the user can type SHIP in chat.
- Governance rule (v1.1): risk levels measure PRODUCTION publish/usage impact
  of the code the risk describes - documentation-only concerns are never
  high/critical. Recalibrate obviously over-leveled open risks in this
  project's SSOT files the same way: downgrade to the real production impact
  and write the recalibration date + reason into the risk's
  `Last re-evaluation` line. NEVER downgrade a genuine production/security
  risk - keep it and record its planned mitigation instead.

Step 3 - VERIFY (read-only, no git pushes, no database):
- `npm run risks` prints the risk report.
- `npm run feature:new -- example-feature <group>` creates a file, then
  delete it and re-run `npm run ssot:index` to keep the index clean.

Step 4 - REPORT back, briefly: what was changed, which risks were
recalibrated and why, and the verification result.

Hard rules:
- Do NOT run `npm run ship` / `npm run rel` / `npm run release` during this
  update - they push to git. Afterward they may run only when the user says
  SHIP in chat.
- Files only; never touch any database or API; never invent secrets.
- Keep every machine contract from the guide (h1, 5-cell decision rows,
  task-group/task-item/risk-item data attributes, RELEASE-LOG-ROWS marker).
