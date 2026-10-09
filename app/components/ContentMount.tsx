'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import type { PageSectionCode } from '@/lib/render/render-plan'
import type { WidgetCssEntry, WidgetScriptEntry, WidgetShellEntry } from '@/lib/render/widget-islands'

/**
 * ContentMount (Section 11) — the ONE client component that mounts page
 * content from htmlPage.code:
 *
 * - injects `code.html` (only content authors' data.html is mounted raw —
 *   Section 19 trust boundary; user data is NEVER rendered this way)
 * - tolerates embedded <style>/<script> inside the html: styles hoist to
 *   <head>, scripts are extracted and executed (like legacy html-code)
 * - appends `code.css` to <head>, deduped per contentId
 * - executes `code.js` sequentially after double rAF, inside an IIFE via a
 *   Blob URL; top-level function declarations are assigned to window
 *   (`window.fn = fn = function ...`); CMS-script errors are isolated from
 *   the app shell via targeted capture and reported as `gw:script-error`
 * - dispatches `gw:content-ready` after scripts ran
 * - supports SPA navigation: `[data-ic-nav-href]` clicks and `ic-navigate`
 *   events route through the Next.js router; content re-mounts (and scripts
 *   re-run) on route change via effect dependencies
 */

export interface ContentMountProps {
  contentId: string
  html: string
  css?: string
  js?: string
  className?: string
  /** C14 reusable sections — mounted in order BEFORE the page's own code. */
  sections?: PageSectionCode[]
  /** C14 site-level stylesheet — injected BEFORE section/page css. */
  sharedCss?: string
  /** C14 platform-owned traceability comment (no secrets). */
  traceComment?: string
  /** Widget island SSR layer (progressive-enhancement first paint): the
   *  server-extracted [data-gw-app] islands with ssrHtml injected. Rendered
   *  into the container on the server + first client render; mountContent
   *  then rebuilds the full page and the client render wins. */
  serverHtml?: string
  /** App-store widget stylesheets — injected AFTER page css (deduped per name). */
  widgetCss?: WidgetCssEntry[]
  /** App-store widget code.js — executed AFTER page js, BEFORE auto-mount;
   *  each MUST call gw.apps.register (idempotent). */
  widgetScripts?: WidgetScriptEntry[]
  /** App-store widget shells (D-DWH-30) — re-injected into the rebuilt page
   *  islands on the client with their data-gw-ssr marker, so tool widgets
   *  find their markup when their code.js boots (serverHtml is only the
   *  server first paint; mountContent rebuilds from the original html). */
  widgetShells?: WidgetShellEntry[]
}

export const CSS_ATTR = 'data-gw-css'
export const SHARED_CSS_ATTR = 'data-gw-shared-css'
export const STYLE_ATTR = 'data-gw-content-style'
export const SCRIPT_ATTR = 'data-gw-content-script'
export const WIDGET_CSS_ATTR = 'data-gw-widget-css'
export const READY_EVENT = 'gw:content-ready'
export const SCRIPT_ERROR_EVENT = 'gw:script-error'

/** `^function name(` at column 0 → `window.name = name = function name(`. */
const TOP_LEVEL_FUNCTION_RE = /^(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/gm

/** Top-level function declarations are hoisted to window (Section 11). */
export function hoistTopLevelFunctions(source: string): string {
  return source.replace(TOP_LEVEL_FUNCTION_RE, (match, name: string) => {
    return `window[${JSON.stringify(name)}] = ${name} = ${match}`
  })
}

let scriptErrorCaptured = false

/**
 * Blob-URL script execution: sequential (awaits load), isolated error
 * capture — a failing CMS script never breaks the app shell.
 */
export async function executeCode(code: string): Promise<void> {
  if (!code.trim()) return
  captureScriptErrorsOnce()

  const source = `(function(){\n${hoistTopLevelFunctions(code)}\n}).call(window);\n`
  const blob = new Blob([source], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  const script = document.createElement('script')
  script.src = url
  script.async = false
  await new Promise<void>((resolve) => {
    script.onload = () => resolve()
    script.onerror = () => resolve()
    document.head.appendChild(script)
  })
  script.remove()
  URL.revokeObjectURL(url)
}

function captureScriptErrorsOnce(): void {
  if (scriptErrorCaptured) return
  scriptErrorCaptured = true
  window.addEventListener('error', (event) => {
    if (typeof event.filename === 'string' && event.filename.startsWith('blob:')) {
      // Isolate CMS-script errors from the app shell (Section 11).
      window.dispatchEvent(
        new CustomEvent(SCRIPT_ERROR_EVENT, {
          detail: { message: event.message, filename: event.filename },
        }),
      )
    }
  })
}

export interface MountOptions {
  contentId: string
  html: string
  css: string
  js: string
  sections?: PageSectionCode[]
  sharedCss?: string
  traceComment?: string
  widgetCss?: WidgetCssEntry[]
  widgetScripts?: WidgetScriptEntry[]
  widgetShells?: WidgetShellEntry[]
}

export interface MountHooks {
  execute?: (code: string) => Promise<void>
  now?: () => number
  raf?: (callback: FrameRequestCallback) => number
  cancelRaf?: (handle: number) => void
}

/**
 * Full mount procedure. Returns a cleanup that cancels pending work and
 * removes the injected head styles of this contentId.
 */
export function mountContent(
  container: HTMLElement,
  options: MountOptions,
  hooks: MountHooks = {},
): () => void {
  const execute = hooks.execute ?? executeCode
  const raf = hooks.raf ?? ((callback) => window.requestAnimationFrame(callback))
  const cancelRaf = hooks.cancelRaf ?? ((handle) => window.cancelAnimationFrame(handle))

  const styleTags: HTMLStyleElement[] = []
  const scriptSources: string[] = []
  const sectionExecSources: string[] = []
  let cancelled = false
  let pendingRaf = 0

  // 0. C14 sharedCss first — site-level, deduped, injected BEFORE any
  //    section/page css so page rules win the cascade.
  const sharedCss = (options.sharedCss ?? '').trim()
  if (sharedCss) {
    const style = document.createElement('style')
    style.setAttribute(SHARED_CSS_ATTR, '')
    style.textContent = sharedCss
    replaceTagged(document.head, `style[${SHARED_CSS_ATTR}]`, style)
    styleTags.push(style)
  }

  // 1. C14 reusable sections first (IN ORDER), each with its own dedupe key
  //    (section objectId) for style hoisting and css.
  const sections = options.sections ?? []
  container.textContent = ''
  for (const section of sections) {
    const sectionKey = `section-${section.objectId}`
    appendFragment(container, section.html, sectionKey, styleTags, sectionExecSources)
    if (section.css.trim()) {
      const style = document.createElement('style')
      style.setAttribute(CSS_ATTR, sectionKey)
      style.textContent = section.css
      replaceTagged(document.head, `style[${CSS_ATTR}="${sectionKey}"]`, style)
      styleTags.push(style)
    }
    if (section.js.trim()) sectionExecSources.push(section.js)
  }

  // 2. Parse + inject the page html (scripts do NOT run inside a <template>).
  appendFragment(container, options.html, options.contentId, styleTags, scriptSources)

  // 3. C14 traceability comment — prepended to the page container.
  if (options.traceComment) {
    container.insertBefore(document.createComment(options.traceComment), container.firstChild)
  }

  // 3.5 Widget island shells (D-DWH-30): the server first paint rendered the
  //     SSR layer (serverHtml), but this mount rebuilds the page from the
  //     original html — re-inject the shell + data-gw-ssr marker so tool
  //     widgets find their markup when their code.js boots.
  injectWidgetShells(container, options.widgetShells ?? [])

  // 4. Append code.css to <head>, deduped per contentId (after shared/section css).
  if (options.css.trim()) {
    const style = document.createElement('style')
    style.setAttribute(CSS_ATTR, options.contentId)
    style.textContent = options.css
    replaceTagged(document.head, `style[${CSS_ATTR}="${options.contentId}"]`, style)
    styleTags.push(style)
  }

  // 4.5 Widget island css (app-store catalog) — appended AFTER page css,
  //     deduped per widget name (widget island SSR contract, Step A.5).
  const widgetJsSources: string[] = []
  for (const entry of options.widgetScripts ?? []) {
    if (entry.js.trim()) widgetJsSources.push(entry.js)
  }
  for (const entry of options.widgetCss ?? []) {
    const widgetCss = (entry.css ?? '').trim()
    if (!widgetCss) continue
    const style = document.createElement('style')
    style.setAttribute(WIDGET_CSS_ATTR, entry.name)
    style.textContent = widgetCss
    replaceTagged(
      document.head,
      `style[${WIDGET_CSS_ATTR}="${escapeCssAttributeValue(entry.name)}"]`,
      style,
    )
    styleTags.push(style)
  }

  // 5. Sequential execution after double rAF (Section 11): section code
  //    first (in order), then the page's embedded scripts + code.js, then
  //    the widget code.js blocks (hydration — before auto-mount).
  const run = () => {
    if (cancelled) return
    pendingRaf = raf(() => {
      if (cancelled) return
      pendingRaf = raf(async () => {
        if (cancelled) return
        for (const source of [...sectionExecSources, ...scriptSources, options.js, ...widgetJsSources]) {
          if (cancelled) return
          await execute(source)
        }
        if (!cancelled) {
          // Platform-level island mount (Section 35 / C12): content scripts
          // may call gw.apps.mount() themselves, but the platform re-mounts
          // AFTER html injection so islands always render on SPA re-init
          // (the idempotent data-gw-mounted guard prevents double mounts).
          try {
            const gwBridge = window as unknown as {
              gw?: { apps?: { mount?: (root?: ParentNode) => void } }
            }
            gwBridge.gw?.apps?.mount?.(container)
          } catch {
            /* widget mounting is best-effort — gw:app-error surfaces issues */
          }
          window.dispatchEvent(
            new CustomEvent(READY_EVENT, { detail: { contentId: options.contentId } }),
          )
        }
      })
    })
  }
  run()

  return () => {
    cancelled = true
    if (pendingRaf !== 0) cancelRaf(pendingRaf)
    for (const style of styleTags) style.remove()
  }
}

function replaceTagged(parent: ParentNode, selector: string, node: HTMLElement): void {
  parent.querySelector(selector)?.remove()
  parent.appendChild(node)
}

/**
 * Re-inject app-store widget shells into the rebuilt page (D-DWH-30): every
 * island whose name has a resolved shell entry gets its data-gw-ssr marker
 * and (for "1"/"template") the shell markup back. Scripts inside the shell
 * are dropped — the widget's code.js runs through the normal script queue.
 */
function injectWidgetShells(container: HTMLElement, shells: WidgetShellEntry[]): void {
  const modesByName = new Map(shells.map((entry) => [entry.name, entry.ssrMode]))
  const htmlByName = new Map(
    shells
      .filter((entry) => (entry.html ?? '').trim().length > 0)
      .map((entry) => [entry.name, (entry.html ?? '').trim()]),
  )
  container.querySelectorAll('[data-gw-app]').forEach((islandNode) => {
    const island = islandNode as HTMLElement
    const islandName = island.getAttribute('data-gw-app') ?? ''
    const ssrMode = modesByName.get(islandName)
    if (ssrMode === undefined || island.hasAttribute('data-gw-ssr')) return
    island.setAttribute('data-gw-ssr', ssrMode)
    const shellHtml = htmlByName.get(islandName)
    if (!shellHtml) return
    const template = document.createElement('template')
    template.innerHTML = shellHtml
    template.content.querySelectorAll('script').forEach((script) => script.remove())
    island.appendChild(template.content)
  })
}

/** Escape a value for use inside a double-quoted CSS attribute selector. */
function escapeCssAttributeValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

/**
 * Inject one html fragment into the container: embedded <style> is hoisted to
 * <head> (deduped per key), embedded <script> is extracted for sequential
 * execution (scripts never run inside a <template>).
 */
function appendFragment(
  container: HTMLElement,
  html: string,
  dedupeKey: string,
  styleTags: HTMLStyleElement[],
  scriptSources: string[],
): void {
  const template = document.createElement('template')
  template.innerHTML = html
  const fragment = template.content

  fragment.querySelectorAll('style').forEach((style) => {
    const hoisted = document.createElement('style')
    hoisted.setAttribute(STYLE_ATTR, dedupeKey)
    hoisted.textContent = style.textContent
    replaceTagged(document.head, `style[${STYLE_ATTR}="${dedupeKey}"]`, hoisted)
    styleTags.push(hoisted)
    style.remove()
  })
  fragment.querySelectorAll('script').forEach((script) => {
    if (script.src) {
      scriptSources.push(script.src)
    } else if (script.textContent) {
      scriptSources.push(script.textContent)
    }
    script.remove()
  })

  container.appendChild(fragment)
}

let spaNavigationInstalled = false

/** One delegated listener for the whole app (Section 2B SPA deep links). */
export function installSpaNavigation(navigate: (href: string) => void): void {
  if (spaNavigationInstalled) return
  spaNavigationInstalled = true

  document.addEventListener('click', (event) => {
    const target = event.target as Element | null
    const trigger = target?.closest?.('[data-ic-nav-href]')
    if (!trigger) return
    const href = trigger.getAttribute('data-ic-nav-href')
    if (!href) return
    event.preventDefault()
    navigate(href)
  })

  window.addEventListener('ic-navigate', (event) => {
    const detail = (event as CustomEvent<{ href?: string } | string>).detail
    const href = typeof detail === 'string' ? detail : detail?.href
    if (href) navigate(href)
  })
}

export function ContentMount({
  contentId,
  html,
  css,
  js,
  className,
  sections,
  sharedCss,
  traceComment,
  serverHtml,
  widgetCss,
  widgetScripts,
  widgetShells,
}: ContentMountProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const router = useRouter()

  useEffect(() => {
    installSpaNavigation((href) => router.push(href))
  }, [router])

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    return mountContent(container, {
      contentId,
      html,
      css: css ?? '',
      js: js ?? '',
      sections,
      sharedCss,
      traceComment,
      widgetCss,
      widgetScripts,
      widgetShells,
    })
  }, [contentId, html, css, js, sections, sharedCss, traceComment, widgetCss, widgetScripts, widgetShells])

  // Widget island SSR layer: when the server resolved islands against the
  // app-store catalog, render their placeholders for the first paint. The
  // initial client render matches the SSR output (same deterministic prop),
  // so hydration is clean; mountContent then rebuilds the full page and the
  // client render wins (widget island SSR contract, Step A/B).
  if (serverHtml) {
    return (
      <div
        ref={containerRef}
        data-gw-content={contentId}
        className={className}
        dangerouslySetInnerHTML={{ __html: serverHtml }}
      />
    )
  }
  return <div ref={containerRef} data-gw-content={contentId} className={className} />
}
