---
applyTo: >
  components/families/charts-analytics/**,
  components/families/display/HtmlToolViewer/**,
  PageBlocks/object-manager/AppScreenResolver.js
description: >
  [One or two sentences: when does the AI read this file. Name the exact
  feature and the trigger phrases, e.g. "Use when developing X, adding Y,
  wiring Z, editing W, or touching route V."]
---

# [Feature name] - [one-line framing]

[2-4 sentence overview. State what the feature is, what was removed or
changed recently, and the single most important guardrail. Example pattern
from the source project:]

The old [legacy system] ([paths]) was REMOVED on [date] - do not
reintroduce it. [Replacement architecture in one sentence.]

The single source of truth for every [feature] decision (prefix D-[CODE]):
`_docs/deny/_feature-development-management/[group]/[feature]/[feature]-ssot.html`
Read it before adding any [feature] code. Keep this md and that SSOT in sync
in the same change (see Documentation Sync Duty in copilot-instructions.md).

Key guards:
- [bullet: a hard rule - what must NOT be done]
- [bullet: an architectural constraint the AI tends to get wrong]
- [bullet: a data-shape or protocol gotcha with the exact path/name]
- [bullet: a storage/runtime constraint, e.g. "never X at runtime (D-[CODE]-NN, D-[CODE]-NN)"]

<!--
  ADAPT FOR YOUR PROJECT:
  - `applyTo` patterns: glob patterns relative to the project root. VS Code
    loads this file whenever the AI edits a matching path.
  - `description`: when the AI should use it.
  - Decision IDs cited here (D-[CODE]-NN) must exist in section 11 of the
    matching SSOT file - the auto-doc cross-references them.
  - Keep the file SHORT (under ~60 lines). Rules only, no prose. The SSOT
    file holds the detail; this md holds the guardrails.
-->
