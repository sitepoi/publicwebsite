# Portable kit - version log

Read this first when updating a project that already has the kit.
The canonical kit lives in the source project; every other project keeps a
COPY and is updated from here (see `kit/SINGLE-SOURCE-SYNC.md`).

## v1.1 - 2026-09-24

- Template renamed to `_ssot-template.html` everywhere (scripts, docs, kit) -
  the filename now says "ssot". `scripts/new-feature-doc.js` reads
  `_template/_ssot-template.html`.
- Added the SHIP release commands:
  - npm scripts `ship` and `SHIP` (full defined release procedure, alias of `rel`).
  - `--force` flag in `release.js`: `npm run ship -- --force` runs the full
    procedure with the gate in warn mode (risks reported but not blocking).
  - npm script `risks` + `scripts/ssot-risks.js` - read-only risk control
    center (same detection logic as the gate, never stages/commits/pushes).
  - Blocked-gate message now points to `npm run risks` and the force flag.
- Added the SHIP chat command (`kit/SHIP-COMMAND.md`): the user types SHIP in
  chat and the AI runs the whole release procedure itself - SHIP (force past
  the gate if blocked and report the risks), SHIP STRICT (strict gate, stop
  if blocked). SHIP is the ONLY trigger for commits/pushes.
- New governance rule: risk levels measure the PRODUCTION publish/usage
  impact of the code the risk describes. Documentation-only concerns are
  never high/critical; plan-stage risks for unbuilt code are recalibrated to
  their real production impact or accepted with the mitigation recorded
  (recalibration date + reason goes into the risk's Last re-evaluation line).
- Porting prompt extended: installs the SHIP rule and forbids the installer
  AI from running release commands during installation.

## v1.0 - 2026-09-24

- Initial portable kit: six scripts, portable 19-section template, the
  self-contained guide html, INSTALL.md, package-json scripts sample,
  sync-duty section + per-feature instruction template.
