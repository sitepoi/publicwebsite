// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import {
  CSS_ATTR,
  READY_EVENT,
  STYLE_ATTR,
  executeCode,
  hoistTopLevelFunctions,
  mountContent,
} from '@/components/ContentMount'

describe('hoistTopLevelFunctions (Section 11 — window hoisting)', () => {
  it('assigns top-level function declarations to window', () => {
    const source = 'function foo() { return 1 }\nfoo();\nasync function bar() {}\n'
    const result = hoistTopLevelFunctions(source)
    expect(result).toContain('window["foo"] = foo = function foo() { return 1 }')
    expect(result).toContain('window["bar"] = bar = async function bar() {}')
    expect(result).toContain('foo();')
  })

  it('ignores nested/indented function declarations', () => {
    const source = 'const x = {\n  fn: function inner() {}\n}\n'
    expect(hoistTopLevelFunctions(source)).toBe(source)
  })
})

describe('mountContent (inject html, hoist styles, dedupe css, execute js)', () => {
  function rafQueue(raf: ReturnType<typeof vi.fn>) {
    const callbacks: FrameRequestCallback[] = []
    raf.mockImplementation((cb: FrameRequestCallback) => {
      callbacks.push(cb)
      return callbacks.length
    })
    return async () => {
      while (callbacks.length > 0) {
        const batch = callbacks.splice(0)
        for (const callback of batch) callback(0)
      }
      await Promise.resolve()
    }
  }

  it('injects html, hoists embedded styles to head, removes embedded scripts from DOM', async () => {
    document.head.innerHTML = ''
    document.body.innerHTML = '<div id="root"></div>'
    const container = document.getElementById('root')!

    const execute = vi.fn(async () => undefined)
    const raf = vi.fn()
    const flush = rafQueue(raf)

    const cleanup = mountContent(
      container,
      {
        contentId: 'page-1',
        html: '<h1>Hello</h1><style>.embedded { color: red }</style><script>window.embeddedRan = true</script>',
        css: '.page { color: blue }',
        js: 'window.pageRan = true;',
      },
      { execute, raf, cancelRaf: vi.fn() },
    )

    expect(container.innerHTML).toBe('<h1>Hello</h1>')
    expect(container.querySelectorAll('script')).toHaveLength(0)
    expect(document.head.querySelector(`style[${STYLE_ATTR}="page-1"]`)?.textContent).toBe(
      '.embedded { color: red }',
    )
    expect(document.head.querySelector(`style[${CSS_ATTR}="page-1"]`)?.textContent).toBe(
      '.page { color: blue }',
    )

    await flush()
    await flush()

    // Sequential execution: embedded scripts first, then code.js.
    expect(execute).toHaveBeenCalledTimes(2)
    expect(execute).toHaveBeenNthCalledWith(1, 'window.embeddedRan = true')
    expect(execute).toHaveBeenNthCalledWith(2, 'window.pageRan = true;')

    cleanup()
    expect(document.head.querySelector(`style[${CSS_ATTR}="page-1"]`)).toBeNull()
    expect(document.head.querySelector(`style[${STYLE_ATTR}="page-1"]`)).toBeNull()
  })

  it('dispatches gw:content-ready after scripts executed', async () => {
    document.head.innerHTML = ''
    document.body.innerHTML = '<div id="root2"></div>'
    const container = document.getElementById('root2')!

    const execute = vi.fn(async () => undefined)
    const raf = vi.fn()
    const flush = rafQueue(raf)
    const ready = vi.fn()
    window.addEventListener(READY_EVENT, ready)

    mountContent(
      container,
      {
        contentId: 'page-2',
        html: '<p>x</p>',
        css: '',
        js: 'void 0',
      },
      { execute, raf, cancelRaf: vi.fn() },
    )

    await flush()
    await flush()

    expect(ready).toHaveBeenCalledTimes(1)
    const detail = ready.mock.calls[0]?.[0] as CustomEvent
    expect(detail.detail).toEqual({ contentId: 'page-2' })
  })

  it('dedupes page css per contentId (replace, not duplicate)', async () => {
    document.head.innerHTML = ''
    document.body.innerHTML = '<div id="root3"></div>'
    const container = document.getElementById('root3')!

    const raf = vi.fn()
    const flush = rafQueue(raf)
    mountContent(
      container,
      { contentId: 'page-3', html: '<p>a</p>', css: '.a{}', js: '' },
      { raf, cancelRaf: vi.fn() },
    )
    await flush()
    await flush()
    mountContent(
      container,
      { contentId: 'page-3', html: '<p>b</p>', css: '.b{}', js: '' },
      { raf, cancelRaf: vi.fn() },
    )

    const styles = document.head.querySelectorAll(`style[${CSS_ATTR}="page-3"]`)
    expect(styles).toHaveLength(1)
    expect(styles[0]?.textContent).toBe('.b{}')
  })

  it('cancels pending script execution on cleanup', async () => {
    document.head.innerHTML = ''
    document.body.innerHTML = '<div id="root4"></div>'
    const container = document.getElementById('root4')!

    const execute = vi.fn(async () => undefined)
    const raf = vi.fn()
    const cancelRaf = vi.fn()
    const cleanup = mountContent(
      container,
      { contentId: 'page-4', html: '<p>x</p>', css: '', js: 'window.shouldNotRun = true' },
      { execute, raf, cancelRaf },
    )

    cleanup()
    // raf queued → cancellation should prevent execution once flushed.
    expect(cancelRaf).toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})

describe('executeCode', () => {
  it('is a no-op for empty code', async () => {
    const appendSpy = vi.spyOn(document.head, 'appendChild')
    await executeCode('   ')
    expect(appendSpy).not.toHaveBeenCalled()
    appendSpy.mockRestore()
  })
})
