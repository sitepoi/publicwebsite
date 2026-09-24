## Documentation Sync Duty - md + SSOT (automatic, never wait to be asked)

Every code change, behavior change, or design decision made in AI chat that
touches a feature below MUST update BOTH files in the same change:
1. the matching instruction file in `.github/instructions/`
2. the feature SSOT html under `_docs/deny/_feature-development-management/`

SSOT update rules: update the file in the same change as the code; log every
decision in section 11 (decision register) with the feature's D-prefix and
today's date; update section 3 (existing capabilities) when behavior changes.
The instruction md mirrors the same change as rules and gotchas. Do this
without the user asking.

| Instruction md | SSOT html (path under `_docs/deny/_feature-development-management/`) | D-prefix |
|---|---|---|
| `api-management.instructions.md` | `admin/api-management/api-management-ssot.html` | D-APIM |
| `ai-agent-chat.instructions.md` | `ai/ai-agent-chat/ai-agent-chat-ssot.html` | D-AICH |
| `app-designer.instructions.md` | `admin/app-designer/app-designer-ssot.html`, `admin/field-group-designer/field-group-designer-ssot.html`, `admin/category-designer/category-designer-ssot.html` | D-APPD, D-FGRP, D-CATG |
| `content-manager.instructions.md` | `content/content-manager/content-manager-ssot.html` | D-CNTM |
| `field-component-registration.instructions.md` | `content/field-component-registration/field-component-registration-ssot.html` | D-FREG |
| `html-tool-system.instructions.md` | `ai/html-tool-system/html-tool-system-ssot.html` | D-HTMLT |
| `object-manager.instructions.md` | `content/object-manager/object-manager-ssot.html` | D-OBJM |
| `reporting.instructions.md` | `reporting/html-report-tools/html-report-tools-ssot.html` | D-RPTL |
| `spreadsheet-editor.instructions.md` | `editors/spreadsheet-editor/spreadsheet-editor-ssot.html` | D-SPRD |

Limits: this duty runs during AI chat work. Changes the user makes by hand
outside a chat are not detected - then a short chat mention ("I changed X")
is enough for the sync to happen.

<!--
  ADAPT FOR YOUR PROJECT:
  - Replace the table rows with YOUR features. The md path and the SSOT html
    path must be real paths in the target project.
  - The D-prefix must be UNIQUE per feature across the whole project - it is
    the identifier used in decision rows (D-APIM-01, D-APIM-02, ...) and
    cited in commit messages, release notes and the auto-doc.
  - If the target codebase does not use `.github/instructions/`, keep the
    same rule with the instruction-folder convention the project already has
    (e.g. AGENTS.md files). The core rule never changes: instruction md and
    SSOT html are updated in the same change as the code, without being asked.
-->
