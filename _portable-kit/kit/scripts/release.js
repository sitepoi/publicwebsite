// ── ONE-COMMAND RELEASE (npm run rel / npm run ship / npm run SHIP) ───────
// Auto publish flow only:
//   1. git add -A
//   2. git commit with a SHORT, concise AI-generated message (one line)
//   3. npm version patch  (bumps package.json, commits + tags)
//   4. git push --follow-tags
//
// The heavy context (code diff since last push, SSOT decision registers,
// AI chat history) is NOT used here - it lives in scripts/releaseContext.js
// and feeds the documentation generator:
//   npm run document:feature   → document changes since the last push
//   npm run document:month     → document changes in the current month
//
// AI backend + env vars: see scripts/releaseContext.js (app's own AI gateway
// by default - no API key needed anywhere).
//
//   RELEASE_COMMIT_MESSAGE="your message"  → skip AI, use a fixed message
//
//   RELEASE_SSOT_GATE=strict|warn|off      → push gate on SSOT open risks
//                                            (default strict)
//   RELEASE_SSOT_GATE_LEVEL=critical|high|medium|low
//                                          → minimum risk level that blocks
//                                            (default high: critical + high
//                                            block unless accepted)
//   RELEASE_SSOT_GROUPS=all|key1,key2      → stamp the shipped tasks with the
//                                            version, commit and date-time of
//                                            this push; groups move to pushed
//
//   npm run ship -- --force                → run the FULL procedure with the
//                                            gate in warn mode (risks are
//                                            reported but do not stop the
//                                            push) - same as
//                                            RELEASE_SSOT_GATE=warn
//   npm run risks                          → read-only report of every open
//                                            risk before shipping (see
//                                            scripts/ssot-risks.js)
//
// Run with:  npm run rel   ·   npm run ship

const { writeFileSync, readFileSync, mkdtempSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const context = require('./releaseContext')

const MAX_SHORT_MESSAGE_DIFF_CHARS = 12000

const riskLevelRank = { low: 1, medium: 2, high: 3, critical: 4 }

function buildShortCommitPrompt() {
	const pushedCommit = context.getPushedCommit()
	const changedFiles = context.getChangedFileList(pushedCommit)
	const codeDiff = context.getDiffSinceCommit(pushedCommit, MAX_SHORT_MESSAGE_DIFF_CHARS)
	return [
		'Write ONE short git commit message line for the code changes below.',
		'',
		'=== CHANGED FILES ===',
		changedFiles || '(none)',
		'',
		'=== CODE DIFF (truncated) ===',
		codeDiff || '(no changes)',
		'',
		'Rules:',
		'- A SINGLE line, maximum 72 characters, starting with a conventional-commit prefix (feat/fix/chore/docs/refactor/perf/test).',
		'- Only a concise summary of WHAT changed. No bullets, no explanation, no markdown, no quotes.',
	].join('\n')
}




function checkSsotPushGate() {
	// "npm run ship -- --force" runs the full procedure with the gate in
	// warn mode: risks are reported but do not stop the push.
	const forceShipRequested = process.argv.slice(2).includes('--force')
	const gateMode = forceShipRequested ? 'warn' : (process.env.RELEASE_SSOT_GATE || 'strict').toLowerCase()
	if (gateMode === 'off') return
	const thresholdLevel = (process.env.RELEASE_SSOT_GATE_LEVEL || 'high').toLowerCase()
	const thresholdRank = riskLevelRank[thresholdLevel] || riskLevelRank.high

	const openRisks = context.getOpenRisksFromSsotDocuments()
	if (openRisks.length === 0) {
		console.log('→ SSOT push gate: no open risks. CLEAR.')
		return
	}

	const levelCounts = {}
	openRisks.forEach((risk) => {
		const level = risk.level || 'medium'
		levelCounts[level] = (levelCounts[level] || 0) + 1
	})
	console.log('→ SSOT risk report - remaining open risks overall:')
	Object.keys(levelCounts)
		.sort((levelA, levelB) => (riskLevelRank[levelB] || 0) - (riskLevelRank[levelA] || 0))
		.forEach((level) => console.log('    ' + level + ': ' + levelCounts[level]))

	const blockingRisks = openRisks.filter((risk) => (riskLevelRank[risk.level] || riskLevelRank.medium) >= thresholdRank)
	if (blockingRisks.length > 0) {
		console.log('→ Blocking risks for this push (level >= ' + thresholdLevel + '):')
		blockingRisks.forEach((risk) => {
			console.log('    - ' + risk.documentName + ': ' + risk.riskId + ' [' + risk.level + '] ' + risk.riskTitle)
		})
		if (gateMode === 'strict') {
			throw new Error('Push blocked: ' + blockingRisks.length + ' open risk(s) at or above the "' + thresholdLevel + '" level. Review them with: npm run risks. Solve or accept them in their SSOT files, then re-run - or run: npm run ship -- --force to ship anyway (gate warn mode).')
		}
		console.log('→ Gate mode is "warn" - continuing anyway.')
	} else {
		console.log('→ No risks at or above the "' + thresholdLevel + '" level - push allowed by the gate.')
	}
}

function stampPushedTasks() {
	const groupsSetting = (process.env.RELEASE_SSOT_GROUPS || '').trim()
	if (!groupsSetting) {
		console.log('→ Tip: set RELEASE_SSOT_GROUPS=all or a comma-separated list of group keys to stamp the shipped tasks with this push.')
		return
	}
	const groupsToStamp = groupsSetting === 'all' ? null : new Set(groupsSetting.split(',').map((key) => key.trim()).filter(Boolean))
	const documents = context.listSsotFeatureDocuments()
	if (documents.length === 0) return

	let version = ''
	try { version = require('../package.json').version } catch (_e) { /* package.json missing */ }
	let commitHash = ''
	try { commitHash = context.runCommand('git rev-parse HEAD', { silent: true }).trim() } catch (_e) { /* no commit */ }
	const pushedAt = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC'
	let stampedTaskCount = 0

	for (const document of documents) {
		let documentContent
		try { documentContent = readFileSync(document.path, 'utf8') } catch (_e) { continue }
		let documentChanged = false

		const groupPattern = /<section class="task-group" data-release-group="([^"]+)"[^>]*>/g
		let groupMatch
		while ((groupMatch = groupPattern.exec(documentContent)) !== null) {
			const groupKey = groupMatch[1]
			if (groupsToStamp && !groupsToStamp.has(groupKey)) continue

			const groupStart = groupMatch.index
			const groupEnd = documentContent.indexOf('</section>', groupStart)
			const groupBlockEnd = groupEnd === -1 ? documentContent.length : groupEnd
			let groupBlock = documentContent.slice(groupStart, groupBlockEnd)

			const taskPattern = /<div class="task-item" data-task-id="[^"]*"[^>]*>/g
			let taskMatch
			while ((taskMatch = taskPattern.exec(groupBlock)) !== null) {
				const taskTag = taskMatch[0]
				if (taskTag.includes('data-pushed-version')) continue // already stamped
				let stampedTag = taskTag.slice(0, -1)
				// shipped tasks become permanently done in the file - ssot.js
				// reads data-task-status="done" on load in every browser.
				if (taskTag.includes('data-task-status=')) {
					stampedTag = stampedTag.replace(/data-task-status="[^"]*"/, 'data-task-status="done"')
				} else {
					stampedTag += ' data-task-status="done"'
				}
				stampedTag += ' data-pushed-version="' + version + '" data-pushed-commit="' + commitHash + '" data-pushed-at="' + pushedAt + '">'
				groupBlock = groupBlock.replace(taskTag, stampedTag)
				stampedTaskCount++
			}

			if (!groupBlock.includes('data-group-status="pushed"')) {
				groupBlock = groupBlock.replace(/data-group-status="[^"]*"/, 'data-group-status="pushed"')
			}

			if (groupBlock !== documentContent.slice(groupStart, groupBlockEnd)) {
				documentContent = documentContent.slice(0, groupStart) + groupBlock + documentContent.slice(groupBlockEnd)
				documentChanged = true
			}
		}

		if (documentChanged) {
			try { writeFileSync(document.path, documentContent, 'utf8') } catch (_e) { /* read-only document - skip */ }
		}
	}

	if (stampedTaskCount > 0) console.log('→ Stamped ' + stampedTaskCount + ' task(s) with push v' + version + ' (' + commitHash + ').')
	else console.log('→ No matching groups found to stamp (RELEASE_SSOT_GROUPS=' + groupsSetting + ').')
}

function appendReleaseLogEntries({ commitMessage }) {
	const documents = context.listSsotFeatureDocuments()
	if (documents.length === 0) {
		console.log('→ No SSOT feature documents found - release log skipped.')
		return
	}
	let version = ''
	try { version = require('../package.json').version } catch (_e) { /* package.json missing */ }
	let commitHash = ''
	try { commitHash = context.runCommand('git rev-parse --short HEAD', { silent: true }).trim() } catch (_e) { /* no commit */ }
	const today = new Date().toISOString().slice(0, 10)
	const escapedMessage = commitMessage.split(/\r?\n/)[0]
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')

	let updatedCount = 0
	for (const document of documents) {
		let documentContent
		try { documentContent = readFileSync(document.path, 'utf8') } catch (_e) { continue }
		const marker = '<!-- RELEASE-LOG-ROWS'
		const markerIndex = documentContent.indexOf(marker)
		if (markerIndex === -1) continue
		const newRow = '    <tr><td>' + today + '</td><td>' + version + '</td><td>' + commitHash + '</td><td>' + escapedMessage + '</td></tr>\n    '
		try {
			writeFileSync(document.path, documentContent.slice(0, markerIndex) + newRow + documentContent.slice(markerIndex), 'utf8')
			updatedCount++
		} catch (_e) { /* read-only document - skip */ }
	}
	if (updatedCount > 0) console.log('→ Release log updated in ' + updatedCount + ' SSOT document(s).')
	else console.log('→ No SSOT document had a release-log marker - skipped.')
}

async function main() {
	const fixedMessage = process.env.RELEASE_COMMIT_MESSAGE
	if (!fixedMessage) {
		console.log('→ Staging all changes (git add -A)')
	}
	context.runCommand('git add -A', { silent: true })

	const codeDiff = context.getDiffSinceLastPush().trim()
	const unpushedCommits = context.getUnpushedCommitLog().trim()
	if (!codeDiff && !unpushedCommits) {
		console.log('Nothing to commit - the tree matches the last push. Running npm version patch only.')
		context.runCommand('npm version patch')
		context.runCommand('git push --follow-tags')
		return
	}

	checkSsotPushGate()

	let commitMessage
	if (fixedMessage) {
		commitMessage = fixedMessage
	} else {
		console.log('→ Generating a short commit message...')
		commitMessage = context.cleanMessage(await context.getAiResponse(buildShortCommitPrompt()))
		commitMessage = commitMessage.split(/\r?\n/)[0].trim()
		if (!commitMessage) {
			throw new Error('The AI returned an empty commit message. Set RELEASE_COMMIT_MESSAGE to skip AI.')
		}
	}

	console.log('→ Committing with the generated message...')
	const messageFilePath = join(mkdtempSync(join(tmpdir(), 'release-msg-')), 'COMMIT_EDITMSG')
	writeFileSync(messageFilePath, commitMessage, 'utf8')
	context.runCommand(`git commit -F "${messageFilePath}"`)

	console.log('→ Bumping the patch version...')
	context.runCommand('npm version patch')

	console.log('→ Pushing with tags...')
	context.runCommand('git push --follow-tags')

	console.log('→ Updating the SSOT release logs...')
	appendReleaseLogEntries({ commitMessage })

	console.log('→ Stamping shipped tasks with this push...')
	stampPushedTasks()

	try {
		require('./build-ssot-index').buildSsotIndex()
	} catch (indexError) {
		console.log('→ SSOT index update skipped (' + (indexError?.message || indexError) + ')')
	}

	console.log('→ Committing the SSOT document updates...')
	context.runCommand('git add _docs/deny/_feature-development-management', { silent: true })
	let hasStagedDocChanges = false
	try {
		context.runCommand('git diff --cached --quiet', { silent: true })
	} catch (_e) {
		hasStagedDocChanges = true
	}
	if (hasStagedDocChanges) {
		context.runCommand('git commit -m "docs: update SSOT release logs"')
		context.runCommand('git push')
	} else {
		console.log('→ No SSOT document changes to commit.')
	}

	console.log('\nRelease complete.')
	console.log('Commit message used: ' + commitMessage)
}

main().catch((releaseError) => {
	console.error('\nRelease failed:', releaseError?.message || releaseError)
	process.exit(1)
})
