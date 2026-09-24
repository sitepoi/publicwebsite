// ── NEW FEATURE DOCUMENT SCAFFOLD (npm run feature:new -- <name>) ───────────
// Copies the SSOT feature template into _docs/deny/_feature-development-management/<group>/<name>/<name>-ssot.html,
// fills the feature name (title, h1, sidebar, footer), today's date, and a
// suggested decision ID prefix derived from the name.
//
// Usage:  npm run feature:new -- report-builder [core|content|ai|editors|admin|reporting|families|tooling]
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs')
const { join } = require('path')

// ── ADAPT FOR YOUR PROJECT: the single source of truth root folder. ────────
// Everything else in this kit assumes this exact layout:
//   <SSOT_DIR>/_template/_ssot-template.html   ← the feature template
//   <SSOT_DIR>/<group>/<feature>/<feature>-ssot.html   ← one file per feature
//   <SSOT_DIR>/ssot.css + ssot.js                ← shared design/behavior
const SSOT_DIR = join(__dirname, '..', '_docs', 'deny', '_feature-development-management')
const TEMPLATE_PATH = join(SSOT_DIR, '_template', '_ssot-template.html')

function toTitleCase(nameSlug) {
	return nameSlug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ')
}

function toDecisionPrefix(nameSlug) {
	const initials = nameSlug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase())
		.join('')
	return 'D-' + initials.slice(0, 4)
}

function main() {
	const featureNameSlug = (process.argv[2] || '').trim().toLowerCase()
	if (!featureNameSlug) {
		console.error('Usage: npm run feature:new -- <feature-name> [group]')
		process.exit(1)
	}

	const featureGroup = (process.argv[3] || '').trim().toLowerCase()
	const featureDir = join(SSOT_DIR, featureGroup || featureNameSlug)
	const outputPath = join(featureDir, featureNameSlug + '-ssot.html')
	if (existsSync(outputPath)) {
		console.error('Already exists: ' + outputPath)
		process.exit(1)
	}

	const featureTitle = toTitleCase(featureNameSlug)
	const decisionPrefix = toDecisionPrefix(featureNameSlug)
	const today = new Date().toISOString().slice(0, 10)

	let documentContent = readFileSync(TEMPLATE_PATH, 'utf8')
	documentContent = documentContent.split('[FEATURE NAME]').join(featureTitle)
	documentContent = documentContent.split('[CODE]').join(decisionPrefix)
	documentContent = documentContent.split('2026-09-19').join(today)
	// the copied file sits one folder deeper than the template - fix the
	// relative css/js links so the shared design still loads.
	documentContent = documentContent.split('href="../ssot.css"').join('href="../../ssot.css"')
	documentContent = documentContent.split('src="../ssot.js"').join('src="../../ssot.js"')

	mkdirSync(featureDir, { recursive: true })
	writeFileSync(outputPath, documentContent, 'utf8')
	console.log('Created: ' + outputPath)
	console.log('Feature title: ' + featureTitle)
	console.log('Suggested decision prefix: ' + decisionPrefix + ' (change it if it collides with another feature)')
	console.log('Next steps: replace the remaining [PLACEHOLDERS] and remove the TEMPLATE comments.')
}

main()
