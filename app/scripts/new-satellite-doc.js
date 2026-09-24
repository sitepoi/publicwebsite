// ── SATELLITE DOCUMENT SCAFFOLD (npm run satellite:new) ────────────────────
// Creates a per-feature satellite document (help, marketing, updates,
// social - which also carries the WhatsApp messages, onepager and
// presentation) inside a folder next to the feature's SSOT file, or the
// monthly digest in _monthly/. Satellite files start with "_" so the release
// gate, the auto-doc and the control tower index skip them - only the SSOT
// file of a feature is scanned.
//
// Usage:
//   npm run satellite:new -- <feature-name> <help|marketing|updates|social|onepager|presentation> [group]
//   npm run satellite:new -- monthly
//
// The group is auto-detected from the feature's SSOT file location; pass it
// explicitly (core|website|sdk|data|forms|flow|auth|cart|pay|email|search|events|seo) when
// the SSOT file does not exist yet.
const { readFileSync, writeFileSync, existsSync, mkdirSync } = require('fs')
const { join } = require('path')

// ── ADAPT FOR YOUR PROJECT: SSOT root and the group folder names. ──────────
const SSOT_DIR = join(__dirname, '..', '..', '_docs', 'deny', '_feature-development-management')
const TEMPLATE_DIR = join(SSOT_DIR, '_template')
// ── ADAPT FOR YOUR PROJECT: this repo's real domain groups. ────────────────
const GROUP_DIRS = ['core', 'website', 'sdk', 'data', 'forms', 'flow', 'auth', 'cart', 'pay', 'email', 'search', 'events', 'seo']
const SATELLITE_TYPES = ['help', 'marketing', 'updates', 'social', 'onepager', 'presentation']
// Shared assets per type: onepager and presentation use their own heavy
// css/js files shared by every feature; the others use ssot.css.
const SATELLITE_ASSETS = {
	help: { css: '../../ssot.css', js: '' },
	marketing: { css: '', js: '' },
	updates: { css: '../../ssot.css', js: '' },
	social: { css: '../../ssot.css', js: '' },
	onepager: { css: '../../onepager.css', js: '../../onepager.js' },
	presentation: { css: '../../presentation.css', js: '../../presentation.js' },
}

function toTitleCase(nameSlug) {
	return nameSlug
		.split(/[-_]+/)
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ')
}

function findSsotGroup(featureNameSlug) {
	const matchingGroups = GROUP_DIRS.filter((groupDir) =>
		existsSync(join(SSOT_DIR, groupDir, featureNameSlug, featureNameSlug + '-ssot.html')))
	if (matchingGroups.length === 1) return matchingGroups[0]
	return matchingGroups.length > 1 ? 'multiple' : ''
}

function buildSatelliteContent(featureNameSlug, satelliteType, groupDir, todayDate) {
	const featureTitle = toTitleCase(featureNameSlug)
	const ssotRelativeLink = featureNameSlug + '-ssot.html'   // same folder as the satellites
	const cssClassName = featureNameSlug.replace(/[^a-z0-9_-]+/g, '-')
	const assetPaths = SATELLITE_ASSETS[satelliteType] || { css: '../../ssot.css', js: '' }
	return readFileSync(join(TEMPLATE_DIR, '_' + satelliteType + '-template.html'), 'utf8')
		.split('[FEATURE NAME]').join(featureTitle)
		.split('[SSOT FILE]').join(ssotRelativeLink)
		.split('[DATE]').join(todayDate)
		.split('[CSS_CLASS]').join(cssClassName)
		.split('<link rel="stylesheet" href="[CSS_PATH]" />')
			.join(assetPaths.css ? '<link rel="stylesheet" href="' + assetPaths.css + '" />' : '')
		.split('<script src="[JS_PATH]" defer="defer"></script>')
			.join(assetPaths.js ? '<script src="' + assetPaths.js + '" defer="defer"></script>' : '')
}

function buildMonthlyContent(monthLabel) {
	return readFileSync(join(TEMPLATE_DIR, '_monthly-template.html'), 'utf8')
		.split('[MONTH]').join(monthLabel)
		.replace('[CSS_PATH]', '../ssot.css')
}

function main() {
	const commandArgs = process.argv.slice(2)
	const firstArg = (commandArgs[0] || '').trim().toLowerCase()
	const todayDate = new Date().toISOString().slice(0, 10)
	const currentMonth = todayDate.slice(0, 7)

	if (firstArg === 'monthly') {
		const monthlyDir = join(SSOT_DIR, '_monthly')
		const monthlyOutputPath = join(monthlyDir, currentMonth + '.html')
		if (existsSync(monthlyOutputPath)) {
			console.error('Already exists: ' + monthlyOutputPath)
			process.exit(1)
		}
		mkdirSync(monthlyDir, { recursive: true })
		writeFileSync(monthlyOutputPath, buildMonthlyContent(currentMonth), 'utf8')
		console.log('Created monthly digest: ' + monthlyOutputPath)
		return
	}

	const featureNameSlug = firstArg
	const satelliteType = (commandArgs[1] || '').trim().toLowerCase()
	const requestedGroup = (commandArgs[2] || '').trim().toLowerCase()

	if (!featureNameSlug || !SATELLITE_TYPES.includes(satelliteType)) {
		console.error('Usage: npm run satellite:new -- <feature-name> <help|marketing|updates|social|onepager|presentation> [group]')
		console.error('   or: npm run satellite:new -- monthly')
		process.exit(1)
	}

	const featureGroup = requestedGroup || findSsotGroup(featureNameSlug)
	if (!GROUP_DIRS.includes(featureGroup)) {
		console.error('Could not find the SSOT file of "' + featureNameSlug + '".')
		console.error('Pass the group explicitly: ' + GROUP_DIRS.join('|'))
		process.exit(1)
	}

	const satelliteDir = join(SSOT_DIR, featureGroup, featureNameSlug)
	const satelliteOutputPath = join(satelliteDir, '_' + satelliteType + '.html')
	if (existsSync(satelliteOutputPath)) {
		console.error('Already exists: ' + satelliteOutputPath)
		process.exit(1)
	}

	mkdirSync(satelliteDir, { recursive: true })
	writeFileSync(satelliteOutputPath, buildSatelliteContent(featureNameSlug, satelliteType, featureGroup, todayDate), 'utf8')
	console.log('Created: ' + satelliteOutputPath)
	console.log('SSOT: ' + join(SSOT_DIR, featureGroup, featureNameSlug, featureNameSlug + '-ssot.html'))
	console.log('Next steps: replace the [PLACEHOLDERS] with real content.')
}

if (require.main === module) {
	main()
}

module.exports = { findSsotGroup, buildSatelliteContent, buildMonthlyContent, SATELLITE_TYPES, GROUP_DIRS }
