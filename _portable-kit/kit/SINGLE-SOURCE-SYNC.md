# One source, many projects - keeping every codebase in sync

## The model

- ONE canonical home: the source project's
  `_docs/deny/_feature-development-management/_portable-kit/`. All edits to
  the kit happen HERE first, never in a target project.
- Every other project keeps a COPY at `<project>/_portable-kit/`. That copy
  is read-only in practice - fixes flow back to the canonical home.
- The kit is versioned in `kit/KIT-VERSION.md`; every change to the kit
  bumps the version in the SAME change (same discipline as the SSOT files).

## Propagating an update to a project

Option A - one command from the canonical project:

    npm run kit:sync -- "d:/path/to/other-project"

This copies the kit, the templates and the shared css/js into the target.
Then paste `kit/UPDATE-PROMPT.md` into that project's AI chat to apply the
delta (rename template if needed, refresh scripts, add npm scripts, add the
SHIP chat command, recalibrate risk levels to production impact).

Option B - manual:

1. Copy the whole `_portable-kit/` folder into the target project root.
2. Paste `kit/UPDATE-PROMPT.md` into that project's AI chat.

## Rules for updating

1. Change the canonical kit FIRST and bump `kit/KIT-VERSION.md` in the same
   change.
2. Sync targets with `kit:sync` + `UPDATE-PROMPT.md`.
3. The target AI applies the delta, adapts anything project-specific
   (group folder names, AI gateway env vars, transcript scanner, instruction
   convention) and reports back.
4. Never edit the kit inside a target project - improvements go to the
   canonical home first, then flow out.

## Growth options

- Many projects: a tiny loop script in the canonical project can run
  `kit:sync` for every project path - one command updates all of them.
- Dedicated repo: promote the kit to its own git repository and consume it
  as a git submodule or an npm package (e.g. `@your-org/ssot-kit`); then a
  single `npm update` (or `git submodule update`) applies everywhere.
- The scripts are path-relative, so they work unchanged in any project that
  keeps the `_docs/deny/_feature-development-management/` layout; the
  `SSOT_DIR` constants marked "ADAPT FOR YOUR PROJECT" are the only thing a
  different layout needs to change.
