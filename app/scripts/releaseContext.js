// ── SHARED RELEASE CONTEXT (used by release.js and document-changes.js) ────
// Collects dynamic project context from:
//   a) git (diff, commit logs, changed files since any commit ref)
//   b) SSOT decision registers (all *.html documents under
//      _docs/deny/_feature-development-management/) - only rows related to
//      the given range (matched by ID in the diff, or newly added to the docs)
//   c) this project's VS Code Copilot transcript (other projects' chats are
//      filtered out by project-path mentions; RELEASE_CONTEXT_FILE overrides)
//
// AI backend selection (the first available wins). ADAPTED FOR THIS PROJECT:
// this repo has NO app-level AI gateway, so the scripts use a generic
// OpenAI-compatible endpoint or local Ollama:
//   1) Explicit OpenAI-compatible endpoint:
//        RELEASE_AI_BASE_URL=https://api.deepseek.com
//        DEEPSEEK_API_KEY=sk-...              (RELEASE_AI_API_KEY also works)
//        RELEASE_AI_MODEL=deepseek-chat       (optional)
//   2) Local Ollama (last resort):
//        OLLAMA_HOST=http://localhost:11434 (optional)
//        RELEASE_OLLAMA_MODEL=deepseek-r1:14b (optional)

const { execSync } = require('child_process')
const { readFileSync, readdirSync, statSync } = require('fs')
const { homedir } = require('os')
const { join } = require('path')

const MAX_TRANSCRIPT_FILES_TO_SCAN = 30
const MAX_TRANSCRIPT_READ_CHARS = 500000
const MAX_CONVERSATION_CHARS = 12000
const MAX_RELEVANT_DECISION_ROWS = 15
// ── ADAPT FOR YOUR PROJECT ──────────────────────────────────────────────────
// The SSOT root lives at the REPO root (_docs/...), one folder above the
// npm project root (app/), so the path goes up two levels from app/scripts/.
// This project has no legacy technical-decision-documents folder - removed.
const SSOT_FEATURES_DIR = join(__dirname, '..', '..', '_docs', 'deny', '_feature-development-management')

const DEEPSEEK_DEFAULT_BASE_URL = 'https://api.deepseek.com'
const DEEPSEEK_DEFAULT_MODEL = 'deepseek-chat'

// Load the same env files the Next.js app uses (.env.local first, then .env),
// so RELEASE_AI_* / DEEPSEEK_API_KEY can live there without exporting them
// in the shell. Shell variables always take precedence (override: false).
// Values are never printed.
try { require('dotenv').config({ path: join(__dirname, '..', '.env.local'), override: false }) } catch (_e) { /* dotenv not installed */ }
try { require('dotenv').config({ path: join(__dirname, '..', '.env'), override: false }) } catch (_e) { /* ignore */ }

// ── General helpers ────────────────────────────────────────────────────────
function runCommand(command, options = {}) {
	return execSync(command, { stdio: options.silent ? 'pipe' : 'inherit', encoding: 'utf8', ...options })
}

function truncateMiddle(text, maxChars) {
	if (!text || text.length <= maxChars) return text || ''
	const half = Math.floor(maxChars / 2)
	return text.slice(0, half) + '\n\n... (truncated) ...\n\n' + text.slice(-half)
}

function truncateTail(text, maxChars) {
	if (!text || text.length <= maxChars) return text || ''
	return '... (older part truncated) ...\n\n' + text.slice(-maxChars)
}

function stripHtml(htmlText) {
	return String(htmlText || '')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&amp;/g, '&')
		.replace(/&quot;/g, '"')
		.replace(/\s+/g, ' ')
		.trim()
}

function cleanMessage(rawMessage) {
	return String(rawMessage || '')
		.replace(/```[a-z]*\n?/gi, '')
		.replace(/```/g, '')
		.trim()
}

// ── a) Git context ─────────────────────────────────────────────────────────
function getPushedCommit() {
	try {
		return runCommand('git rev-parse @{push}', { silent: true }).trim()
	} catch (_e) { return '' }
}

function getLastPushTime() {
	const pushedCommit = getPushedCommit()
	if (!pushedCommit) return ''
	try {
		return runCommand(`git show -s --format=%cI ${pushedCommit}`, { silent: true }).trim()
	} catch (_e) { return '' }
}

function getCommitTime(commitRef) {
	try {
		return runCommand(`git show -s --format=%cI ${commitRef}`, { silent: true }).trim()
	} catch (_e) { return '' }
}

function getUnpushedCommitLog() {
	const pushedCommit = getPushedCommit()
	try {
		return pushedCommit
			? runCommand(`git log --oneline ${pushedCommit}..HEAD`, { silent: true }).trim()
			: ''
	} catch (_e) { return '' }
}

function getCommitLogSince(commitRef, maxCount = 100) {
	const range = commitRef ? `${commitRef}..HEAD` : 'HEAD'
	try {
		return runCommand(`git log -${maxCount} --pretty=format:%h %ad %s --date=short ${range}`, { silent: true }).trim()
	} catch (_e) { return '' }
}

function getChangedFileList(commitRef) {
	try {
		return commitRef
			? runCommand(`git diff --name-status ${commitRef} -- .`, { silent: true }).trim()
			: runCommand('git diff --name-status HEAD -- .', { silent: true }).trim()
	} catch (_e) { return '' }
}

function getDiffSinceLastPush() {
	const pushedCommit = getPushedCommit()
	if (pushedCommit) return runCommand(`git diff ${pushedCommit} -- .`, { silent: true })
	return runCommand('git diff HEAD -- .', { silent: true })
}

function getDiffSinceCommit(commitRef, maxChars) {
	let codeDiff = ''
	try {
		codeDiff = commitRef
			? runCommand(`git diff ${commitRef} -- .`, { silent: true })
			: runCommand('git diff HEAD -- .', { silent: true })
	} catch (_e) { return '' }
	return truncateMiddle(codeDiff, maxChars)
}

// ── b) Decision registers from SSOT documents (only rows related to the range) ──
function listSsotFeatureDocuments() {
	const documents = []
	const documentDirs = [SSOT_FEATURES_DIR]
	const walkFeatureDirectory = (documentDir) => {
		for (const entry of readdirSync(documentDir, { withFileTypes: true })) {
			if (entry.name.startsWith('_')) continue   // templates and helpers are not feature SSOTs
			if (entry.isDirectory()) { walkFeatureDirectory(join(documentDir, entry.name)); continue }
			if (entry.isFile() && entry.name.endsWith('.html')) {
				documents.push({ name: entry.name, path: join(documentDir, entry.name) })
			}
		}
	}
	for (const documentDir of documentDirs) {
		try { walkFeatureDirectory(documentDir) } catch (_e) { /* directory may not exist yet - still works */ }
	}
	return documents
}

function listDecisionDocuments() {
	return listSsotFeatureDocuments()
}

// ── d) Push gate - open risks in SSOT documents ────────────────────────────
function getOpenRisksFromSsotDocuments() {
	const openRisks = []
	for (const document of listSsotFeatureDocuments()) {
		let documentContent
		try { documentContent = readFileSync(document.path, 'utf8') } catch (_e) { continue }
		const riskItemPattern = /<div class="risk-item"[^>]*>/g
		let riskMatch
		while ((riskMatch = riskItemPattern.exec(documentContent)) !== null) {
			const blockStart = riskMatch.index
			const blockEnd = documentContent.indexOf('</details>', blockStart)
			const block = documentContent.slice(blockStart, blockEnd === -1 ? blockStart + 2000 : blockEnd)
			const idMatch = block.match(/data-risk-id="([^"]+)"/)
			const statusMatch = block.match(/data-risk-status="([^"]+)"/)
			const levelMatch = block.match(/data-risk-level="([^"]+)"/) || block.match(/data-risk-severity="([^"]+)"/)
			const solvedCheckboxMatch = block.match(/class="risk-solved-checkbox"[^>]*checked/)
			const titleMatch = block.match(/class="risk-title">([^<]+)/)
			const status = statusMatch ? statusMatch[1] : 'open'
			const isSolved = Boolean(solvedCheckboxMatch)
			if (!isSolved && status !== 'accepted' && status !== 'solved') {
				openRisks.push({
					documentName: document.name,
					riskId: idMatch ? idMatch[1] : 'unknown',
					riskTitle: titleMatch ? titleMatch[1].trim() : '(unnamed risk)',
					level: levelMatch ? levelMatch[1] : 'medium',
				})
			}
		}
	}
	return openRisks
}

function parseDecisionRows(documentContent, documentName) {
	const decisionRows = []
	const rowPattern = /<tr>\s*<td>(D-[A-Z]+-\d+)<\/td><td>([^<]*)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td>([\s\S]*?)<\/td>\s*<td[^>]*>([^<]*)<\/td>\s*<\/tr>/g
	let rowMatch
	while ((rowMatch = rowPattern.exec(documentContent)) !== null) {
		decisionRows.push({
			id: rowMatch[1],
			date: rowMatch[2].trim(),
			decision: stripHtml(rowMatch[3]),
			rationale: stripHtml(rowMatch[4]),
			status: rowMatch[5].trim(),
			documentName,
		})
	}
	return decisionRows
}

function getDecisionIdsAddedToDocumentSinceCommit(documentPath, commitRef) {
	const addedDecisionIds = new Set()
	if (!commitRef) return addedDecisionIds
	let documentDiff
	try {
		documentDiff = runCommand(`git diff ${commitRef} -- "${documentPath}"`, { silent: true })
	} catch (_e) { return addedDecisionIds }
	for (const line of documentDiff.split(/\r?\n/)) {
		if (!line.startsWith('+') || line.startsWith('+++')) continue
		for (const match of line.matchAll(/D-[A-Z]+-\d+/g)) addedDecisionIds.add(match[0])
	}
	return addedDecisionIds
}

function getDecisionRegisterContext({ codeDiff, unpushedCommits, pushedCommit }) {
	const documents = listDecisionDocuments()
	if (documents.length === 0) return ''

	const changedText = (codeDiff + '\n' + unpushedCommits).toLowerCase()
	const allDecisionRows = []
	const addedIdsByDocument = new Map()
	for (const document of documents) {
		let documentContent
		try { documentContent = readFileSync(document.path, 'utf8') } catch (_e) { continue }
		const decisionRows = parseDecisionRows(documentContent, document.name)
		if (decisionRows.length > 0) {
			addedIdsByDocument.set(document.name, getDecisionIdsAddedToDocumentSinceCommit(document.path, pushedCommit))
		}
		allDecisionRows.push(...decisionRows)
	}
	if (allDecisionRows.length === 0) return ''

	const relevantRows = allDecisionRows.filter(decisionRow => {
		if (changedText.includes(decisionRow.id.toLowerCase())) return true
		const addedIds = addedIdsByDocument.get(decisionRow.documentName)
		return addedIds ? addedIds.has(decisionRow.id) : false
	})

	const rowsToShow = relevantRows.length > 0 ? relevantRows : allDecisionRows.slice(-3)
	const note = relevantRows.length > 0
		? `${relevantRows.length} of ${allDecisionRows.length} recorded decisions relate to this range (matched by ID in the diff, or newly added in the SSOT doc):`
		: 'No decisions are directly referenced by this change; showing the latest decisions for context:'
	return [
		`${documents.length} SSOT document(s) found.`,
		note,
		...rowsToShow.slice(-MAX_RELEVANT_DECISION_ROWS).map(decisionRow =>
			`- ${decisionRow.id} (${decisionRow.date}, ${decisionRow.status}, doc: ${decisionRow.documentName}): ${decisionRow.decision} Rationale: ${decisionRow.rationale}`),
	].join('\n')
}

// ── c) Latest AI discussion (this project's chats only) ────────────────────
// ── ADAPT FOR YOUR PROJECT: this scans VS Code Copilot transcripts on
// Windows (%APPDATA%\Code\User\workspaceStorage\*\GitHub.copilot-chat\transcripts\*.jsonl).
// For another editor/OS, rewrite listAllTranscriptFiles, or set
// RELEASE_CONTEXT_FILE to a fixed transcript path.
function getProjectSearchTokens() {
	const projectPath = process.cwd().replace(/\\/g, '/').toLowerCase()
	const tokens = [projectPath]
	const projectBaseName = projectPath.split('/').pop() || ''
	if (projectBaseName) tokens.push(projectBaseName)
	// VS Code file-URI variants used inside transcripts
	const encodedDrivePath = projectPath.replace(/^([a-z]):/, '$1%3A')
	tokens.push('file:///' + encodedDrivePath, encodedDrivePath)
	return tokens
}

function listAllTranscriptFiles() {
	const workspaceStorageDir = join(homedir(), 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage')
	const transcriptFiles = []
	try {
		for (const workspaceEntry of readdirSync(workspaceStorageDir, { withFileTypes: true })) {
			if (!workspaceEntry.isDirectory()) continue
			const transcriptsDir = join(workspaceStorageDir, workspaceEntry.name, 'GitHub.copilot-chat', 'transcripts')
			let directoryEntries
			try { directoryEntries = readdirSync(transcriptsDir) } catch (_e) { continue }
			for (const fileName of directoryEntries) {
				if (!fileName.endsWith('.jsonl')) continue
				const filePath = join(transcriptsDir, fileName)
				let modifiedTimeMs = 0
				try { modifiedTimeMs = statSync(filePath).mtimeMs } catch (_e) { /* ignore */ }
				transcriptFiles.push({ filePath, modifiedTimeMs })
			}
		}
	} catch (_e) { /* no transcripts at all */ }
	transcriptFiles.sort((a, b) => b.modifiedTimeMs - a.modifiedTimeMs)
	return transcriptFiles.slice(0, MAX_TRANSCRIPT_FILES_TO_SCAN)
}

function countProjectMentionsInTranscript({ filePath, searchTokens }) {
	let projectMentionCount = 0
	try {
		const transcriptContent = readFileSync(filePath, 'utf8').slice(0, MAX_TRANSCRIPT_READ_CHARS).toLowerCase()
		for (const token of searchTokens) {
			let foundAtIndex = 0
			while ((foundAtIndex = transcriptContent.indexOf(token, foundAtIndex)) !== -1) {
				projectMentionCount++
				foundAtIndex += token.length
			}
		}
	} catch (_e) { /* ignore unreadable transcript */ }
	return projectMentionCount
}

function selectProjectTranscript() {
	const transcriptFiles = listAllTranscriptFiles()
	if (transcriptFiles.length === 0) return { filePath: null, reason: 'no transcripts found' }
	const searchTokens = getProjectSearchTokens()
	let bestFile = transcriptFiles[0]
	let bestScore = 0
	for (const transcriptFile of transcriptFiles) {
		const projectMentionCount = countProjectMentionsInTranscript({ filePath: transcriptFile.filePath, searchTokens })
		if (projectMentionCount > bestScore) {
			bestScore = projectMentionCount
			bestFile = transcriptFile
		}
	}
	if (bestScore === 0) {
		return { filePath: transcriptFiles[0].filePath, reason: 'fallback: no transcript mentions this project, using the newest one' }
	}
	return { filePath: bestFile.filePath, reason: `matched this project (${bestScore} project-path mentions)` }
}

function extractTranscriptMessages(transcriptFilePath, sinceTime) {
	let transcriptLines
	try {
		transcriptLines = readFileSync(transcriptFilePath, 'utf8').split(/\r?\n/)
	} catch (_e) { return '' }

	const messages = []
	for (const line of transcriptLines) {
		if (!line.trim()) continue
		let entry
		try { entry = JSON.parse(line) } catch (_e) { continue }
		const timestamp = entry?.timestamp || ''
		if (sinceTime && timestamp && timestamp < sinceTime) continue
		const content = entry?.data?.content
		if (entry?.type === 'user.message' && typeof content === 'string') {
			messages.push('User: ' + content.replace(/\s+/g, ' ').trim())
		} else if (entry?.type === 'assistant.message' && typeof content === 'string' && content.trim()) {
			messages.push('Assistant: ' + content.replace(/\s+/g, ' ').trim())
		}
	}
	return messages.join('\n\n')
}

function getConversationContext({ sinceTime = '', maxChars = MAX_CONVERSATION_CHARS } = {}) {
	const effectiveSinceTime = sinceTime || getLastPushTime()
	let transcriptFilePath = process.env.RELEASE_CONTEXT_FILE
	let selectionReason = 'RELEASE_CONTEXT_FILE override'
	if (!transcriptFilePath) {
		const selection = selectProjectTranscript()
		transcriptFilePath = selection.filePath
		selectionReason = selection.reason
	}
	if (!transcriptFilePath) {
		console.log('→ No Copilot transcript found; skipping AI discussion context.')
		return ''
	}
	console.log(`→ Conversation source: ${truncateMiddle(transcriptFilePath, 100)} (${selectionReason})`)
	const extracted = extractTranscriptMessages(transcriptFilePath, effectiveSinceTime)
	return truncateTail(extracted, maxChars)
}

// ── AI backends ────────────────────────────────────────────────────────────
async function askOpenAiCompatible({ prompt, baseUrl, apiKey, model }) {
	const response = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
		},
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: prompt }],
			temperature: 0.4,
		}),
	})
	if (!response.ok) {
		throw new Error(`AI endpoint returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
	}
	const data = await response.json()
	return data?.choices?.[0]?.message?.content || ''
}

async function askOllama({ prompt, host, model }) {
	const response = await fetch(`${host.replace(/\/$/, '')}/api/chat`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			model,
			messages: [{ role: 'user', content: prompt }],
			stream: false,
		}),
	})
	if (!response.ok) {
		throw new Error(`Ollama returned ${response.status}: ${(await response.text()).slice(0, 200)}`)
	}
	const data = await response.json()
	return data?.message?.content || ''
}

// Generic AI call used by both scripts; tries each backend in order.
async function getAiResponse(prompt) {
	// 1) Explicit OpenAI-compatible endpoint (DeepSeek by default)
	const explicitBaseUrl = process.env.RELEASE_AI_BASE_URL
	const explicitApiKey = process.env.RELEASE_AI_API_KEY || process.env.DEEPSEEK_API_KEY || ''
	if (explicitBaseUrl || explicitApiKey) {
		return askOpenAiCompatible({
			prompt,
			baseUrl: explicitBaseUrl || DEEPSEEK_DEFAULT_BASE_URL,
			apiKey: explicitApiKey,
			model: process.env.RELEASE_AI_MODEL || DEEPSEEK_DEFAULT_MODEL,
		})
	}
	// 2) Local Ollama
	console.log('→ No RELEASE_AI_BASE_URL / API key configured - falling back to local Ollama.')
	return askOllama({
		prompt,
		host: process.env.OLLAMA_HOST || 'http://localhost:11434',
		model: process.env.RELEASE_OLLAMA_MODEL || 'deepseek-r1:14b',
	})
}

module.exports = {
	runCommand,
	truncateMiddle,
	truncateTail,
	stripHtml,
	cleanMessage,
	getPushedCommit,
	getLastPushTime,
	getCommitTime,
	getUnpushedCommitLog,
	getCommitLogSince,
	getChangedFileList,
	getDiffSinceLastPush,
	getDiffSinceCommit,
	getDecisionRegisterContext,
	getConversationContext,
	listSsotFeatureDocuments,
	getOpenRisksFromSsotDocuments,
	getAiResponse,
}
