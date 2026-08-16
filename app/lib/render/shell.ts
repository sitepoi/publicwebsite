import type { SiteSettings } from '@/lib/contracts/site-settings'
import type { GwContext } from '@/lib/gw-sdk'
import { buildGwBootstrapScript } from '@/lib/gw-sdk'
import type { StructuredDataEntry } from './render-plan'

/**
 * Server-side shell builders (Section 7.4 / 2B chrome rows) — pure functions
 * returning HTML snippets rendered by the RSC shell. All inputs are ADMIN
 * config/content from the site's default-settings object (Section 19 trust
 * boundary); user data never reaches these slots.
 */

export type GwBootstrapContext = GwContext

/** Inline gw bootstrap context — must run BEFORE content scripts (Section 12). */
export function buildBootstrapScript(context: GwBootstrapContext): string {
  return buildGwBootstrapScript(context)
}

/** Theme CSS variables (Section 7.4): cssVariables as-is, colors → --gw-color-*. */
export function buildThemeStyle(settings: SiteSettings): string {
  const variables: Record<string, string> = {}
  for (const [key, value] of Object.entries(settings.theme?.colors ?? {})) {
    if (typeof value === 'string') variables[`--gw-color-${key}`] = value
  }
  for (const [key, value] of Object.entries(settings.theme?.cssVariables ?? {})) {
    if (typeof value === 'string') variables[key] = value
  }
  const entries = Object.entries(variables)
  if (entries.length === 0) return ''
  const body = entries.map(([key, value]) => `  ${key}: ${value};`).join('\n')
  return `:root {\n${body}\n}`
}

/** Theme cssClasses (Section 7.4) as body wrapper class tokens. */
export function buildThemeClasses(settings: SiteSettings): string {
  return (settings.theme?.cssClasses ?? [])
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .join(' ')
}

/** Slot code helpers (replace the legacy additions-* slots). */
export function headCodeOf(settings: SiteSettings): string {
  return nonEmpty(settings.headCode)
}

export function bodyStartCodeOf(settings: SiteSettings): string {
  return nonEmpty(settings.bodyStartCode)
}

export function bodyEndCodeOf(settings: SiteSettings): string {
  return nonEmpty(settings.bodyEndCode)
}

function nonEmpty(value: string | undefined): string {
  return value && value.trim().length > 0 ? value : ''
}

/** Analytics plugin ids are admin config but still limited to safe id chars. */
const SAFE_ID_RE = /^[A-Za-z0-9_-]+$/

export interface AnalyticsSnippet {
  src?: string
  content?: string
  async?: boolean
}

export interface AnalyticsScripts {
  head: AnalyticsSnippet[]
  body: string[]
}

export function buildAnalyticsScripts(plugins: SiteSettings['plugins']): AnalyticsScripts {
  const head: AnalyticsSnippet[] = []
  const body: string[] = []

  const ga = plugins?.googleAnalyticsId
  if (ga && SAFE_ID_RE.test(ga)) {
    head.push({ src: `https://www.googletagmanager.com/gtag/js?id=${ga}`, async: true })
    head.push({
      content: `window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${ga}');`,
    })
  }

  const gtm = plugins?.googleTagId
  if (gtm && SAFE_ID_RE.test(gtm)) {
    head.push({
      content: `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${gtm}');`,
    })
    body.push(
      `<noscript><iframe src="https://www.googletagmanager.com/ns.html?id=${gtm}" height="0" width="0" style="display:none;visibility:hidden"></iframe></noscript>`,
    )
  }

  const pixel = plugins?.facebookPixelId
  if (pixel && SAFE_ID_RE.test(pixel)) {
    head.push({
      content: `!function(f,b,e,v,n,t,s){if(f.fbq)return;n=f.fbq=function(){n.callMethod?n.callMethod.apply(n,arguments):n.queue.push(arguments)};if(!f._fbq)f._fbq=n;n.push=n;n.loaded=!0;n.version='2.0';n.queue=[];t=b.createElement(e);t.async=!0;t.src=v;s=b.getElementsByTagName(e)[0];s.parentNode.insertBefore(t,s)}(window,document,'script','https://connect.facebook.net/en_US/fbevents.js');fbq('init','${pixel}');fbq('track','PageView');`,
    })
  }

  const shareThis = plugins?.shareThis
  if (shareThis && SAFE_ID_RE.test(shareThis)) {
    head.push({
      src: `https://platform-api.sharethis.com/js/sharethis.js#property=${shareThis}&product=inline-share-buttons`,
    })
  }

  return { head, body }
}

/** JSON-LD payloads from the RenderPlan structured data (Section 16). */
export function buildJsonLdScripts(items: StructuredDataEntry[]): string[] {
  return items.map((entry) => JSON.stringify(entry.json).replace(/</g, '\\u003c'))
}
