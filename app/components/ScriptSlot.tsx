'use client'

import { useEffect } from 'react'

/**
 * ScriptSlot (C4) — appends admin-slot scripts (gw bootstrap, headCode,
 * analytics plugins, JSON-LD) to the real <head>/<body> after hydration.
 *
 * React warns when a component renders <script> tags and does not execute
 * them on client re-renders; appending real DOM script nodes avoids that and
 * keeps execution order: ScriptSlots mount (and run) before ContentMount's
 * double-rAF content scripts (Section 12 bootstrap ordering). Idempotent per
 * slot id (replaces the previous node with the same id on re-mount).
 */
export interface ScriptSlotProps {
  id: string
  content?: string
  src?: string
  type?: string
  async?: boolean
  target?: 'head' | 'body'
}

export function ScriptSlot({ id, content, src, type, async, target = 'head' }: ScriptSlotProps) {
  useEffect(() => {
    const parent = target === 'head' ? document.head : document.body
    parent.querySelectorAll(`script[data-gw-slot="${id}"]`).forEach((node) => node.remove())

    const script = document.createElement('script')
    script.setAttribute('data-gw-slot', id)
    if (type) script.type = type
    if (async) script.async = true
    if (content) script.textContent = content
    if (src) script.src = src
    parent.appendChild(script)

    return () => {
      parent.querySelectorAll(`script[data-gw-slot="${id}"]`).forEach((node) => node.remove())
    }
  }, [id, content, src, type, async, target])

  return null
}
