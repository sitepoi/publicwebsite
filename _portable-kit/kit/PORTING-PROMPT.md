# Copy-paste prompt - install the SSOT system into a NEW project

Place the whole `_portable-kit` folder at the root of the target project,
then paste the prompt below into that project's AI (VS Code Copilot chat in
that workspace). The AI reads the kit, installs everything, adapts it to the
target codebase, and smoke-tests it.

---

## THE PROMPT (copy everything below this line)

Install the portable "Feature-Development-Management (SSOT)" documentation
system into this project. A complete portable kit was placed at
`_portable-kit/` in this project's root.

Step 1 - READ FIRST, before doing anything:
- Read `_portable-kit/_ssot-system-portable-guide.html` - the full system
  explanation (folder layout, the 19-section feature file, machine contracts,
  scripts, push gate, release flow).
- Read `_portable-kit/kit/INSTALL.md` - the step-by-step installation recipe.
Follow the guide and the recipe exactly; they are the source of truth for
this task.

Step 2 - INSTALL:
- Create `_docs/deny/_feature-development-management/` and place the template
  from `_portable-kit/kit/template/_ssot-template.html` into its `_template/`
  folder.
- Copy the six scripts from `_portable-kit/kit/scripts/` into this project's
  `scripts/` folder.
- Merge the entries from `_portable-kit/kit/package-json-scripts.json` into
  this project's `package.json` "scripts" block (adjust the `scripts/` path
  if this project has no scripts folder - then update the SSOT_DIR constants
  inside each script so they all agree).
- If `ssot.css` / `ssot.js` are not part of the kit copy, create minimal
  placeholder files with the same names in `_docs/deny/_feature-development-management/`
  (a small readable CSS; an empty JS) and note that the full versions can be
  copied from the source project later - the feature files must stay
  functional without them.

Step 3 - ADAPT to this project (ask me if unsure):
- Replace the group folder names (`core, content, ai, editors, admin,
  reporting, families, tooling` in `new-satellite-doc.js`) with THIS
  project's real domains.
- Wire the AI backend: if this project has its own AI gateway, rename the
  `UNICON_AI_GATEWAY_*` env vars in `releaseContext.js` to this project's
  gateway env vars; otherwise document that `RELEASE_AI_BASE_URL` +
  `RELEASE_AI_API_KEY` or local Ollama must be configured (tell me which one
  applies - do not invent keys).
- If this project is not on Windows + VS Code, adapt
  `listAllTranscriptFiles` in `releaseContext.js` or note that
  `RELEASE_CONTEXT_FILE` must be set.
- If this project uses a different AI-instructions convention than
  `.github/instructions/*.instructions.md` (e.g. AGENTS.md), add the
  "Documentation Sync Duty" section from
  `_portable-kit/kit/copilot-instructions-sync-duty.md` to that location
  instead, with a sync table listing THIS project's major features and a
  unique D-prefix per feature. If this project has no such convention, create
  a `copilot-instructions.md` at the project root with the adapted section.
- Add the "SHIP chat command" section from `_portable-kit/kit/SHIP-COMMAND.md`
  to the same instructions file, so the user can type SHIP in chat and the AI
  runs the release procedure itself.

Step 4 - SMOKE TEST (never touches git, never touches any database):
- Run `npm run feature:new -- example-feature core` (or an adapted group).
  It must create `_docs/deny/_feature-development-management/<group>/example-feature/example-feature-ssot.html`.
- Run `npm run ssot:index`. It must write `index.html` listing the new file.
- Fix anything that fails, then delete the `example-feature` file and
  re-run `npm run ssot:index` so the index is clean.

Step 5 - REPORT back, briefly:
- What was created/where, what was adapted, the smoke-test result, and the
  exact env vars still missing before `npm run rel` and `npm run
  document:feature` can use AI.

Hard rules:
- Do NOT run `npm run rel` / `npm run release` / `npm run ship` / `npm run SHIP`
  during this installation - they push to git. After installation they may be
  run only when the user later says SHIP in chat.
- Do NOT access any database or API; files only.
- Keep every machine contract from the guide (h1, 5-cell decision rows,
  task-group/task-item/risk-item data attributes, RELEASE-LOG-ROWS marker).
- Do not invent API keys or endpoints - ask me when a value is missing.
