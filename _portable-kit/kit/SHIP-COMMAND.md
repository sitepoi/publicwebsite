# SHIP chat command - copy this section into the target project's copilot-instructions.md

After the portable kit is installed, add this section so the USER can type
"SHIP" in chat and the AI runs the whole release procedure - the user never
types npm commands in the terminal.

---

## SHIP Command - chat command, the AI runs it (not a terminal command)

The user types "SHIP" in this chat and the AI executes the whole release
procedure itself. The user never runs npm in the terminal for this.

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
