// ── RISK CONTROL CENTER (npm run risks) ────────────────────────────────────
// Read-only report of every OPEN risk in the SSOT documents, using exactly
// the same detection logic as the release push gate. It never stages,
// commits or pushes anything and never reads the environment - it only
// scans the html files.
//
// Usage:  npm run risks
const { readFileSync, readdirSync } = require('fs')
const { join, relative } = require('path')

// ── ADAPT FOR YOUR PROJECT: same folders the release gate scans. ───────────
// This repo has no legacy technical-decision-documents folder - only the
// SSOT root (at the repo root, two levels up from app/scripts/) is scanned.
const SCAN_DIRS = [
	join(__dirname, '..', '..', '_docs', 'deny', '_feature-development-management'),
]
const RISK_LEVEL_RANK = { low: 1, medium: 2, high: 3, critical: 4 }
// default gate threshold: critical + high block a strict ship
const GATE_BLOCK_RANK = RISK_LEVEL_RANK.high

function collectDocumentPaths() {
	const documentPaths = []
	const walkDirectory = (directoryPath) => {
		for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
			if (entry.name.startsWith('_')) continue   // templates, satellites, helpers - not feature files
			const entryPath = join(directoryPath, entry.name)
			if (entry.isDirectory()) { try { walkDirectory(entryPath) } catch (_e) { /* unreadable */ } continue }
			if (entry.isFile() && entry.name.endsWith('.html')) documentPaths.push(entryPath)
		}
	}
	for (const directoryPath of SCAN_DIRS) {
		try { walkDirectory(directoryPath) } catch (_e) { /* folder may not exist yet */ }
	}
	return documentPaths
}

function parseOpenRisks(documentPath) {
	let content
	try { content = readFileSync(documentPath, 'utf8') } catch (_e) { return [] }
	const openRisks = []
	const riskItemPattern = /<div class="risk-item"[^>]*>/g
	let riskMatch
	while ((riskMatch = riskItemPattern.exec(content)) !== null) {
		const blockStart = riskMatch.index
		const blockEnd = content.indexOf('</details>', blockStart)
		const block = content.slice(blockStart, blockEnd === -1 ? blockStart + 2000 : blockEnd)
		const idMatch = block.match(/data-risk-id="([^"]+)"/)
		const statusMatch = block.match(/data-risk-status="([^"]+)"/)
		const levelMatch = block.match(/data-risk-level="([^"]+)"/) || block.match(/data-risk-severity="([^"]+)"/)
		const solvedCheckboxMatch = block.match(/class="risk-solved-checkbox"[^>]*checked/)
		const titleMatch = block.match(/class="risk-title">([^<]+)/)
		const status = statusMatch ? statusMatch[1] : 'open'
		const isSolved = Boolean(solvedCheckboxMatch)
		if (!isSolved && status !== 'accepted' && status !== 'solved') {
			openRisks.push({
				documentRelativePath: relative(process.cwd(), documentPath).replace(/\\/g, '/'),
				riskId: idMatch ? idMatch[1] : 'unknown',
				riskTitle: titleMatch ? titleMatch[1].trim() : '(unnamed risk)',
				level: levelMatch ? levelMatch[1] : 'medium',
			})
		}
	}
	return openRisks
}

function main() {
	const allOpenRisks = []
	for (const documentPath of collectDocumentPaths()) {
		allOpenRisks.push(...parseOpenRisks(documentPath))
	}

	if (allOpenRisks.length === 0) {
		console.log('→ SSOT risk control center: no open risks. The gate is CLEAR - npm run ship will not be blocked.')
		return
	}

	const sortedRisks = allOpenRisks.sort((riskA, riskB) =>
		(RISK_LEVEL_RANK[riskB.level] || 0) - (RISK_LEVEL_RANK[riskA.level] || 0))
	const blockingRiskCount = sortedRisks.filter((risk) => (RISK_LEVEL_RANK[risk.level] || 0) >= GATE_BLOCK_RANK).length

	console.log('→ SSOT risk control center - ' + sortedRisks.length + ' open risk(s), ' + blockingRiskCount + ' blocking (critical/high):\n')
	for (const risk of sortedRisks) {
		const blocks = (RISK_LEVEL_RANK[risk.level] || 0) >= GATE_BLOCK_RANK ? ' [BLOCKS SHIP]' : ''
		console.log('  ' + risk.level.toUpperCase().padEnd(8) + ' ' + risk.documentRelativePath + '  ' + risk.riskId + '  - ' + risk.riskTitle + blocks)
	}

	console.log('')
	console.log('What this means:')
	console.log('- To clear a risk: open its SSOT file, tick the risk-solved checkbox in the')
	console.log('  html (checked="checked"), or mark it data-risk-status="accepted" with a')
	console.log('  reason and date, then re-run this command.')
	console.log('- npm run ship runs the FULL defined release procedure with the strict gate:')
	console.log('  blocking risks stop it. To ship anyway, run: npm run ship -- --force')
	console.log('  (same as RELEASE_SSOT_GATE=warn - the risks stay recorded and reported).')
}

main()
