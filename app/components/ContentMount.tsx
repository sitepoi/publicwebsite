'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import type { PageSectionCode } from '@/lib/render/render-plan'

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
}

export const CSS_ATTR = 'data-gw-css'
export const SHARED_CSS_ATTR = 'data-gw-shared-css'
export const STYLE_ATTR = 'data-gw-content-style'
export const SCRIPT_ATTR = 'data-gw-content-script'
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

  // 4. Append code.css to <head>, deduped per contentId (after shared/section css).
  if (options.css.trim()) {
    const style = document.createElement('style')
    style.setAttribute(CSS_ATTR, options.contentId)
    style.textContent = options.css
    replaceTagged(document.head, `style[${CSS_ATTR}="${options.contentId}"]`, style)
    styleTags.push(style)
  }

  // 5. Sequential execution after double rAF (Section 11): section code
  //    first (in order), then the page's embedded scripts + code.js.
  const run = () => {
    if (cancelled) return
    pendingRaf = raf(() => {
      if (cancelled) return
      pendingRaf = raf(async () => {
        if (cancelled) return
        for (const source of [...sectionExecSources, ...scriptSources, options.js]) {
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
    })
  }, [contentId, html, css, js, sections, sharedCss, traceComment])

  return <div ref={containerRef} data-gw-content={contentId} className={className} />
}
