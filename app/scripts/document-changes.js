// ── AUTO CHANGE DOCUMENTATION ───────────────────────────────────────────────
// Generates a Markdown changelog for website publishing, built from the same
// dynamic sources the release flow collects (scripts/releaseContext.js):
//   - code diff in the range
//   - commit log in the range
//   - SSOT decision registers (only rows related to the range)
//   - the AI discussion in the range (this project's chats only)
//
// Output: _docs/releases/<name>.md   (override with RELEASE_DOC_OUTPUT=path)
//
// Usage:
//   npm run document:feature   → document changes since the last push
//   npm run document:month     → document changes in the current month

const { writeFileSync, mkdirSync } = require('fs')
const { join, dirname } = require('path')
const context = require('./releaseContext')

// ── ADAPT FOR YOUR PROJECT: changelog output folder at the repo root. ─────
const OUTPUT_DIR = join(__dirname, '..', '..', '_docs', 'releases')
const MAX_DOC_DIFF_CHARS = 60000
const MAX_DOC_CONVERSATION_CHARS = 30000
const MAX_DOC_COMMIT_LOG_CHARS = 15000

function getDocumentationRange(mode) {
	if (mode === 'month') {
		const now = new Date()
		const monthStartDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`
		let sinceCommit = ''
		try {
			sinceCommit = context.runCommand(`git rev-list -1 --before="${monthStartDate} 00:00:00" HEAD`, { silent: true }).trim()
		} catch (_e) { sinceCommit = '' }
		if (!sinceCommit) {
			try {
				sinceCommit = context.runCommand('git rev-list --max-parents=0 HEAD', { silent: true }).trim()
			} catch (_e) { sinceCommit = '' }
		}
		const sinceTime = sinceCommit ? context.getCommitTime(sinceCommit) : ''
		return {
			mode,
			label: `Changes in ${monthStartDate.slice(0, 7)}`,
			sinceCommit,
			sinceTime,
			outputName: `changelog-${monthStartDate.slice(0, 7)}.md`,
		}
	}
	// feature mode: everything since the last push
	const sinceCommit = context.getPushedCommit()
	const sinceTime = context.getLastPushTime()
	const datePart = sinceTime ? sinceTime.slice(0, 10) : 'latest'
	return {
		mode: 'feature',
		label: 'Changes since the last push',
		sinceCommit,
		sinceTime,
		outputName: `feature-${datePart}-${new Date().toISOString().slice(0, 10)}.md`,
	}
}

function buildDocumentationPrompt({ range, codeDiff, commitLog, conversationContext, decisionContext }) {
	return [
		'Write a change documentation / changelog document in Markdown for website publishing.',
		'',
		'=== RANGE ===',
		`${range.label}${range.sinceTime ? ` (commits since ${range.sinceTime})` : ''}`,
		'',
		'=== RELATED DECISIONS FROM SSOT DOCUMENTS ===',
		decisionContext || '(no SSOT documents or no relevant decisions found)',
		'',
		'=== AI DISCUSSION IN THIS RANGE (this project only) ===',
		conversationContext || '(not available)',
		'',
		'=== COMMITS IN THIS RANGE ===',
		commitLog || '(none)',
		'',
		'=== CODE CHANGES IN THIS RANGE (git diff) ===',
		codeDiff || '(no changes)',
		'',
		'Rules:',
		'- Start with "# Changelog - <range label>" and a one-paragraph summary.',
		'- Group the content under "## Highlights", "## New Features", "## Improvements", "## Bug Fixes", "## Technical Notes".',
		'- Use the AI discussion and the decisions to explain WHY changes were made.',
		'- Cite a decision ID (D-SYNC-xx etc.) ONLY when it is actually related.',
		'- End with "## Sources" listing: git range, SSOT documents, AI discussion.',
		'- Plain Markdown, no HTML, no wrapping code fences around the whole document.',
	].join('\n')
}

async function main() {
	const mode = process.argv[2] === 'month' ? 'month' : 'feature'
	const range = getDocumentationRange(mode)
	console.log(`→ Documenting: ${range.label} (since ${range.sinceCommit || 'the beginning'})`)

	const codeDiff = range.sinceCommit
		? context.getDiffSinceCommit(range.sinceCommit, MAX_DOC_DIFF_CHARS)
		: context.getDiffSinceLastPush()
	const commitLog = context.getCommitLogSince(range.sinceCommit, 200).slice(0, MAX_DOC_COMMIT_LOG_CHARS)
	const conversationContext = context.getConversationContext({ sinceTime: range.sinceTime, maxChars: MAX_DOC_CONVERSATION_CHARS })
	const decisionContext = context.getDecisionRegisterContext({ codeDiff, unpushedCommits: commitLog, pushedCommit: range.sinceCommit })

	console.log('→ Asking the AI to write the documentation...')
	const prompt = buildDocumentationPrompt({ range, codeDiff, commitLog, conversationContext, decisionContext })
	const rawDocumentation = await context.getAiResponse(prompt)
	const documentationContent = context.cleanMessage(rawDocumentation)
	if (!documentationContent) {
		throw new Error('The AI returned empty documentation.')
	}

	const outputFilePath = process.env.RELEASE_DOC_OUTPUT || join(OUTPUT_DIR, range.outputName)
	mkdirSync(dirname(outputFilePath), { recursive: true })
	writeFileSync(outputFilePath, documentationContent + '\n', 'utf8')
	console.log(`\nDocumentation written to: ${outputFilePath}`)
}

main().catch((documentationError) => {
	console.error('\nDocumentation failed:', documentationError?.message || documentationError)
	process.exit(1)
})
