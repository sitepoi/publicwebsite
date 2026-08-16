/**
 * window.gw SDK v2 runtime SOURCE (Section 12).
 *
 * This is an EXPLICIT string — never a compiled-function `toString()`. Next's
 * server compiler (Turbopack/SWC) rewrites function bodies at compile time
 * (hoisted `const` → `undefined`, mangled arrow helpers), so serializing
 * compiled functions is unsafe (ADR-005). The source is executed in the
 * browser via lib/gw-sdk/bootstrap.ts and exercised behaviorally by
 * tests/gw-sdk/bootstrap.test.ts.
 *
 * Plain JS inside the template: no backticks, no `${` sequences.
 */
export const SDK_SOURCE = String.raw`function installGwSdk(context) {
  if (typeof window === 'undefined') return

  var host = context.host && context.host.length > 0 ? context.host : 'gw'
  var language = context.language || 'en'
  var currency = context.currency || 'USD'

  // ---------------------------------------------------------------- storage
  function storagePrefix(scope) {
    return 'gw:v1:' + host + ':' + scope + ':'
  }
  function makeStorageArea(scope) {
    var prefix = storagePrefix(scope)
    return {
      get: function get(key) {
        try {
          var store = scope === 'local' ? window.localStorage : window.sessionStorage
          return store.getItem(prefix + key)
        } catch (error) {
          return null
        }
      },
      set: function set(key, value) {
        try {
          var store = scope === 'local' ? window.localStorage : window.sessionStorage
          store.setItem(prefix + key, value)
        } catch (error) {
          /* private mode / quota — ignore */
        }
      },
      remove: function remove(key) {
        try {
          var store = scope === 'local' ? window.localStorage : window.sessionStorage
          store.removeItem(prefix + key)
        } catch (error) {
          /* ignore */
        }
      },
    }
  }
  var storage = makeStorageArea('local')
  storage.session = makeStorageArea('session')

  // ------------------------------------------------------------- navigation
  var routeChangeListeners = []

  function fireRouteChange() {
    for (var index = 0; index < routeChangeListeners.length; index++) {
      routeChangeListeners[index]()
    }
  }
  window.addEventListener('popstate', fireRouteChange)

  function navigate(path) {
    window.dispatchEvent(new CustomEvent('ic-navigate', { detail: { href: path } }))
    fireRouteChange()
  }
  function openUrl(url) {
    window.open(url, '_blank', 'noopener')
  }
  function onRouteChange(listener) {
    routeChangeListeners.push(listener)
    return function off() {
      var index = routeChangeListeners.indexOf(listener)
      if (index >= 0) routeChangeListeners.splice(index, 1)
    }
  }

  function getPageParams() {
    var params = {}
    if (typeof location !== 'undefined' && location.search) {
      new URLSearchParams(location.search).forEach(function merge(value, key) {
        params[key] = value
      })
    }
    var query = context.query || {}
    var queryKeys = Object.keys(query)
    for (var q = 0; q < queryKeys.length; q++) params[queryKeys[q]] = query[queryKeys[q]]
    var pathParams = context.pathParams || {}
    var pathKeys = Object.keys(pathParams)
    for (var p = 0; p < pathKeys.length; p++) params[pathKeys[p]] = pathParams[pathKeys[p]]
    return params
  }

  // -------------------------------------------------------------------- auth
  // Session auth (C9): GET /api/auth/session is the source of truth. The SDK
  // loads it at boot, caches the user, and exposes sync getters + refresh.
  // Passwords NEVER touch localStorage — first-party pages post them
  // in-flight to the session endpoint only.
  var authUser = null
  var authResolve = function () {}
  var authReady = new Promise(function (resolve) {
    authResolve = resolve
  })
  function applyAuthPayload(data) {
    authUser = data && data.user ? data.user : null
    return authUser
  }
  function loadAuth() {
    try {
      fetch('/api/auth/session', { credentials: 'same-origin' })
        .then(function (response) {
          return response.ok ? response.json() : null
        })
        .then(function (data) {
          authResolve(applyAuthPayload(data))
        })
        .catch(function () {
          authResolve(null)
        })
    } catch (error) {
      authResolve(null)
    }
  }
  loadAuth()
  function getUser() {
    return authUser
  }
  function isAuthenticated() {
    return authUser !== null
  }
  function refreshAuth() {
    return fetch('/api/auth/session', { credentials: 'same-origin' })
      .then(function (response) {
        return response.ok ? response.json() : null
      })
      .then(applyAuthPayload)
      .catch(function () {
        return null
      })
  }
  function login(returnUrl) {
    var target = returnUrl || (typeof location !== 'undefined' ? location.pathname : '/')
    // Full-page navigation to the first-party auth pages (C9) — intentional.
    window.location.href = '/p/user/login?returnUrl=' + encodeURIComponent(target)
  }
  function logout() {
    try {
      fetch('/api/auth/session', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'logout' }),
      })
        .catch(function () {})
        .then(function () {
          if (typeof location !== 'undefined') window.location.href = '/'
        })
    } catch (error) {
      /* endpoint unavailable — nothing to revoke */
    }
  }

  // ---------------------------------------------------------------- tracking
  function track(event, data) {
    var payload = data || {}
    try {
      if (typeof window.gtag === 'function') window.gtag('event', event, payload)
    } catch (error) {
      /* optional analytics */
    }
    try {
      if (Array.isArray(window.dataLayer)) {
        window.dataLayer.push(Object.assign({ event: event }, payload))
      }
    } catch (error) {
      /* optional analytics */
    }
    try {
      if (typeof window.fbq === 'function') window.fbq('trackCustom', event, payload)
    } catch (error) {
      /* optional analytics */
    }
  }
  function trackPageView() {
    track('page_view', { page_path: typeof location !== 'undefined' ? location.pathname : '/' })
  }

  // ---------------------------------------------------------------------- UI
  function notify(message, options) {
    var opts = options || {}
    var severity = opts.severity || 'info'
    var toast = document.createElement('div')
    toast.className =
      'gw-toast fixed bottom-4 right-4 z-50 max-w-sm rounded-lg px-4 py-3 text-sm text-white shadow-lg ' +
      (severity === 'error'
        ? 'bg-red-600'
        : severity === 'success'
          ? 'bg-green-600'
          : severity === 'warning'
            ? 'bg-amber-500'
            : 'bg-neutral-800')
    if (opts.title) {
      var toastTitle = document.createElement('div')
      toastTitle.className = 'font-semibold'
      toastTitle.textContent = opts.title
      toast.appendChild(toastTitle)
    }
    var body = document.createElement('div')
    body.textContent = message // never innerHTML — message may be user data
    toast.appendChild(body)
    document.body.appendChild(toast)
    window.setTimeout(function removeToast() {
      toast.remove()
    }, opts.duration || 5000)
  }

  function showModal(html, options) {
    var opts = options || {}
    var overlay = document.createElement('div')
    overlay.className = 'gw-modal fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4'
    var panel = document.createElement('div')
    panel.className = 'gw-modal-panel w-full max-w-lg rounded-lg bg-white p-6 shadow-xl dark:bg-neutral-900'
    if (opts.title) {
      var modalTitle = document.createElement('div')
      modalTitle.className = 'mb-3 text-lg font-semibold'
      modalTitle.textContent = opts.title
      panel.appendChild(modalTitle)
    }
    var content = document.createElement('div')
    // Admin-authored modal html (Section 19 trust boundary — like data.html).
    content.innerHTML = html
    panel.appendChild(content)
    if (opts.closeable !== false) {
      var close = document.createElement('button')
      close.type = 'button'
      close.className = 'gw-modal-close mt-4 rounded border border-neutral-300 px-4 py-2 text-sm hover:bg-neutral-100'
      close.textContent = 'Close'
      close.addEventListener('click', function closeModal() {
        overlay.remove()
      })
      panel.appendChild(close)
    }
    overlay.appendChild(panel)
    document.body.appendChild(overlay)
    return function closeModal() {
      overlay.remove()
    }
  }

  function setLoading(loading) {
    var existing = document.getElementById('gw-loading-overlay')
    if (loading) {
      if (existing) return
      var overlay = document.createElement('div')
      overlay.id = 'gw-loading-overlay'
      overlay.className = 'gw-loading fixed inset-0 z-50 flex items-center justify-center bg-black/30'
      var spinner = document.createElement('div')
      spinner.className = 'h-10 w-10 animate-spin rounded-full border-4 border-neutral-300 border-t-neutral-800'
      overlay.appendChild(spinner)
      document.body.appendChild(overlay)
      return
    }
    if (existing) existing.remove()
  }

  // ---------------------------------------------------------------- sanitize
  function sanitize(html) {
    var purifier = window.DOMPurify
    if (purifier && typeof purifier.sanitize === 'function') {
      try {
        return purifier.sanitize(html, { USE_PROFILES: { html: true } })
      } catch (error) {
        /* fall through to the tag-stripping fallback */
      }
    }
    // Degraded fallback (no DOMPurify): strip all tags, keep text, escape.
    var text = String(html || '').replace(/<[^>]*>/g, '')
    var el = document.createElement('div')
    el.textContent = text
    return el.innerHTML
  }

  // ------------------------------------------------------------------ format
  function formatDate(value, locale) {
    var date = value instanceof Date ? value : new Date(value)
    return new Intl.DateTimeFormat(locale || language).format(date)
  }
  function formatCurrency(amount, overrideCurrency) {
    return new Intl.NumberFormat(language, {
      style: 'currency',
      currency: overrideCurrency || currency,
    }).format(Number(amount))
  }

  // ------------------------------------------------------------------- forms
  // Section 14 client. Contract (server arrives in C6):
  //   POST /api/forms/submit
  //   files present  → multipart FormData (fields + files + gw_hp + formTypeId + submittedAt)
  //   no files       → JSON { formTypeId?, submittedAt, gw_hp, values: {...} }
  //   response 200   → gw:form-success { form, data }
  //   response !200  → gw:form-error   { form, error, status }
  //   network fail   → gw:form-error   { form, error }
  //   required empty → gw:form-invalid { form, errors: [{field, message}] }
  //   honeypot (gw_hp / [data-gw-honeypot]) filled → silently ignored
  var HONEYPOT_NAMES = ['gw_hp', 'website', 'company']

  function fieldEntries(form) {
    var entries = []
    var elements = Array.from(form.elements)
    for (var index = 0; index < elements.length; index++) {
      var input = elements[index]
      if (!input.name) continue
      if (input.type === 'submit' || input.type === 'button' || input.type === 'reset') continue
      if ((input.type === 'checkbox' || input.type === 'radio') && !input.checked) continue
      entries.push({ name: input.name, value: input.type === 'file' ? input.files : input.value })
    }
    return entries
  }

  function requiredErrors(form) {
    var errors = []
    var elements = Array.from(form.elements)
    for (var index = 0; index < elements.length; index++) {
      var input = elements[index]
      if (!input.required) continue
      if (input.value === '' && (!input.files || input.files.length === 0)) {
        errors.push({ field: input.name || input.id || 'field', message: 'Required field' })
      }
    }
    return errors
  }

  function honeypotValue(form) {
    var elements = Array.from(form.elements)
    for (var index = 0; index < elements.length; index++) {
      var input = elements[index]
      var isHoneypot = input.hasAttribute('data-gw-honeypot') || HONEYPOT_NAMES.indexOf(input.name) >= 0
      if (isHoneypot) return input.value
    }
    return ''
  }

  function setBusy(form, busy) {
    form.classList.toggle('gw-busy', busy)
    var status = form.querySelector('[data-gw-form-status]')
    if (status) status.textContent = busy ? 'Submitting…' : ''
    var buttons = Array.from(form.querySelectorAll('button[type="submit"], input[type="submit"]'))
    for (var index = 0; index < buttons.length; index++) {
      buttons[index].disabled = busy
    }
  }

  async function submitForm(form, options) {
    options = options || {}
    if (honeypotValue(form)) return { ok: false }

    var errors = requiredErrors(form)
    if (errors.length > 0) {
      form.dispatchEvent(
        new CustomEvent('gw:form-invalid', { detail: { form: form, errors: errors }, bubbles: true }),
      )
      return { ok: false }
    }

    setBusy(form, true)
    try {
      var entries = fieldEntries(form)
      var hasFiles = entries.some(function hasFile(entry) {
        var value = entry.value
        return (
          value !== null &&
          typeof value === 'object' &&
          typeof value.length === 'number'
        )
      })

      var response
      if (hasFiles) {
        var body = new FormData()
        body.append('gw_hp', honeypotValue(form))
        body.append('submittedAt', String(Date.now()))
        if (options.formTypeId) body.append('formTypeId', options.formTypeId)
        for (var fileIndex = 0; fileIndex < entries.length; fileIndex++) {
          var fileEntry = entries[fileIndex]
          var files = fileEntry.value
          if (files && files.length > 0) {
            for (var file = 0; file < files.length; file++) body.append(fileEntry.name, files[file])
          } else {
            body.append(fileEntry.name, String(fileEntry.value))
          }
        }
        response = await fetch('/api/forms/submit', { method: 'POST', body: body })
      } else {
        var values = {}
        for (var valueIndex = 0; valueIndex < entries.length; valueIndex++) {
          values[entries[valueIndex].name] = String(entries[valueIndex].value)
        }
        var payload = Object.assign(
          { submittedAt: Date.now(), gw_hp: honeypotValue(form) },
          { values: values },
        )
        if (options.formTypeId) payload.formTypeId = options.formTypeId
        response = await fetch('/api/forms/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
      }

      if (response.ok) {
        var data = await response.json().catch(function noJson() {
          return {}
        })
        form.dispatchEvent(
          new CustomEvent('gw:form-success', { detail: { form: form, data: data }, bubbles: true }),
        )
        return { ok: true, status: response.status, data: data }
      }

      var text = await response.text().catch(function noText() {
        return ''
      })
      var error = text || 'Form submission failed'
      form.dispatchEvent(
        new CustomEvent('gw:form-error', {
          detail: { form: form, error: error, status: response.status },
          bubbles: true,
        }),
      )
      return { ok: false, status: response.status, error: error }
    } catch (caught) {
      var message = caught instanceof Error ? caught.message : 'Network error'
      form.dispatchEvent(
        new CustomEvent('gw:form-error', { detail: { form: form, error: message }, bubbles: true }),
      )
      return { ok: false, error: message }
    } finally {
      setBusy(form, false)
    }
  }

  function bindForms(root) {
    var scope = root || document
    var forms = Array.from(scope.querySelectorAll('form[data-gw-form], form.gw-form'))
    for (var index = 0; index < forms.length; index++) {
      var htmlForm = forms[index]
      if (htmlForm.getAttribute('data-gw-bound')) continue
      htmlForm.setAttribute('data-gw-bound', '1')
      htmlForm.addEventListener('submit', function onSubmit(event) {
        event.preventDefault()
        submitForm(htmlForm, {})
      })
    }
  }

  // ---------------------------------------------------------------------- db
  // Section 29 client twins — server endpoints arrive in C7 (documented now).
  var db = {
    query: async function query(params) {
      var response = await fetch('/api/data/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      })
      if (!response.ok) throw new Error('gw.db.query failed with status ' + response.status)
      return response.json()
    },
    get: async function get(params) {
      var url = '/api/data/' + encodeURIComponent(params.cmsObjectType) + '/' + encodeURIComponent(params.objectId)
      var response = await fetch(url)
      if (response.status === 404) return null
      if (!response.ok) throw new Error('gw.db.get failed with status ' + response.status)
      return response.json()
    },
    operation: async function operation(name, payload, options) {
      var body = { operation: name, payload: payload }
      if (options && options.idempotencyKey) body.idempotencyKey = options.idempotencyKey
      var response = await fetch('/api/data/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error('gw.db.operation failed with status ' + response.status)
      return response.json()
    },
    subscribe: function subscribe(channel, onChange) {
      // SSE first (C11) — provider-agnostic server stream. Polling is the
      // fallback when EventSource is unavailable.
      if (typeof EventSource !== 'undefined') {
        var query = []
        if (channel && channel.cmsObjectType) {
          query.push('cmsObjectType=' + encodeURIComponent(channel.cmsObjectType))
        }
        if (channel && channel.folder) query.push('folder=' + encodeURIComponent(channel.folder))
        var source = new EventSource('/api/subscribe' + (query.length ? '?' + query.join('&') : ''))
        var sseTypes = ['added', 'modified', 'removed']
        function onSseMessage(message) {
          var parsed = null
          try {
            parsed = JSON.parse(message.data)
          } catch (error) {
            return
          }
          onChange({ type: message.type, object: parsed })
        }
        for (var t = 0; t < sseTypes.length; t++) {
          source.addEventListener(sseTypes[t], onSseMessage)
        }
        source.addEventListener('gw-event', function (message) {
          var event = null
          try {
            event = JSON.parse(message.data)
          } catch (error) {
            return
          }
          onChange({ type: 'gw-event', event: event })
        })
        return function unsub() {
          source.close()
        }
      }

      // Polling fallback (C7).
      var stopped = false
      var seen = {}
      async function poll() {
        if (stopped) return
        try {
          var requestBody = Object.assign({ pageSize: 200 }, channel || {})
          var response = await fetch('/api/data/query', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
          })
          if (!response.ok) return
          var result = await response.json()
          var current = {}
          for (var index = 0; index < result.items.length; index++) {
            var item = result.items[index]
            current[item.id] = item
          }
          for (var id in current) {
            if (!Object.prototype.hasOwnProperty.call(current, id)) continue
            if (!Object.prototype.hasOwnProperty.call(seen, id)) {
              onChange({ type: 'added', object: current[id] })
            } else if (JSON.stringify(seen[id]) !== JSON.stringify(current[id])) {
              onChange({ type: 'modified', object: current[id] })
            }
          }
          for (var prevId in seen) {
            if (
              Object.prototype.hasOwnProperty.call(seen, prevId) &&
              !Object.prototype.hasOwnProperty.call(current, prevId)
            ) {
              onChange({ type: 'removed', object: seen[prevId] })
            }
          }
          seen = current
        } catch (error) {
          /* transient — retry on the next tick */
        }
      }
      poll()
      var timer = window.setInterval(poll, 5000)
      return function unsub() {
        stopped = true
        window.clearInterval(timer)
      }
    },
  }

  // -------------------------------------------------------------------- apps
  // Section 35 embedding contract (C12): islands via <div data-gw-app>
  // + data-gw-config JSON. Mount is IDEMPOTENT (data-gw-mounted guard) and
  // SPA-safe — re-running registration/mount from data.html scripts never
  // double-mounts. Builtin widgets lazy-load /gw-widgets.js on first use.
  // The registry + load flags live on WINDOW: the bootstrap script re-runs
  // on every SPA navigation (fresh closures) and must share state.
  var appFactories = window.__gwAppFactories || (window.__gwAppFactories = {})
  var appCleanups = typeof WeakMap !== 'undefined' ? new WeakMap() : null
  var BUILTIN_WIDGETS = [
    'menu',
    'cart',
    'checkout-flow',
    'slot-picker',
    'seat-map',
    'account-dashboard',
    'rewards',
    'order-status',
    'search-box',
  ]
  var widgetsLoading = false
  var widgetsLoaded = false
  var widgetsQueue = []

  function loadWidgets(done) {
    if (window.__gwWidgetsLoaded || widgetsLoaded) {
      done()
      return
    }
    widgetsQueue.push(done)
    if (window.__gwWidgetsLoading || widgetsLoading) return
    widgetsLoading = true
    window.__gwWidgetsLoading = true
    var script = document.createElement('script')
    script.src = '/gw-widgets.js'
    script.onload = function onWidgetsLoaded() {
      widgetsLoaded = true
      window.__gwWidgetsLoaded = true
      widgetsLoading = false
      window.__gwWidgetsLoading = false
      var pending = widgetsQueue
      widgetsQueue = []
      for (var index = 0; index < pending.length; index++) pending[index]()
    }
    script.onerror = function onWidgetsError() {
      widgetsLoading = false
      window.__gwWidgetsLoading = false
      var failed = widgetsQueue
      widgetsQueue = []
      for (var retry = 0; retry < failed.length; retry++) failed[retry]()
    }
    document.head.appendChild(script)
  }

  function mountOne(el) {
    var name = el.getAttribute('data-gw-app') || ''
    var factory = appFactories[name]
    if (!factory) {
      if (BUILTIN_WIDGETS.indexOf(name) >= 0) {
        if (el.getAttribute('data-gw-pending')) return
        el.setAttribute('data-gw-pending', '1')
        loadWidgets(function afterWidgets() {
          el.removeAttribute('data-gw-pending')
          mountOne(el)
        })
        return
      }
      el.dispatchEvent(
        new CustomEvent('gw:app-error', {
          detail: { name: name, message: 'app not registered' },
          bubbles: true,
        }),
      )
      return
    }
    if (el.getAttribute('data-gw-mounted')) return
    el.setAttribute('data-gw-mounted', '1')

    var config = {}
    var raw = el.getAttribute('data-gw-config')
    if (raw) {
      try {
        config = JSON.parse(raw)
      } catch (error) {
        el.dispatchEvent(
          new CustomEvent('gw:app-error', {
            detail: { name: name, message: 'invalid data-gw-config JSON' },
            bubbles: true,
          }),
        )
        el.removeAttribute('data-gw-mounted')
        return
      }
    }
    try {
      var cleanup = factory({ el: el, config: config, gw: gw })
      if (typeof cleanup === 'function' && appCleanups) appCleanups.set(el, cleanup)
    } catch (error) {
      el.dispatchEvent(
        new CustomEvent('gw:app-error', { detail: { name: name, error: error }, bubbles: true }),
      )
    }
  }

  function mountApps(root) {
    var scope = root || document
    var elements = Array.from(scope.querySelectorAll('[data-gw-app]'))
    for (var index = 0; index < elements.length; index++) mountOne(elements[index])
  }

  function unmountApps(root) {
    var scope = root || document
    var elements = Array.from(scope.querySelectorAll('[data-gw-app][data-gw-mounted]'))
    for (var index = 0; index < elements.length; index++) {
      var el = elements[index]
      if (appCleanups) {
        var cleanup = appCleanups.get(el)
        if (typeof cleanup === 'function') {
          try {
            cleanup()
          } catch (error) {
            /* cleanup failures never break unmount */
          }
        }
        appCleanups.delete(el)
      }
      el.removeAttribute('data-gw-mounted')
    }
  }

  // ---------------------------------------------------------------- services
  function service(name) {
    return Promise.reject(new Error("gw.service('" + name + "') is not available yet"))
  }

  // ----------------------------------------------------------------- install
  var gw = {
    pageId: context.pageId,
    siteId: context.siteId,
    folderId: context.folderId,
    language: language,
    host: host,
    currency: currency,
    getPageParams: getPageParams,
    navigate: navigate,
    openUrl: openUrl,
    onRouteChange: onRouteChange,
    getUser: getUser,
    isAuthenticated: isAuthenticated,
    authReady: authReady,
    refreshAuth: refreshAuth,
    login: login,
    logout: logout,
    storage: storage,
    track: track,
    trackPageView: trackPageView,
    notify: notify,
    showModal: showModal,
    setLoading: setLoading,
    sanitize: sanitize,
    formatDate: formatDate,
    formatCurrency: formatCurrency,
    forms: { submit: submitForm, bind: bindForms },
    db: db,
    apps: {
      register: function register(name, factory) {
        appFactories[name] = factory
      },
      mount: mountApps,
      unmount: unmountApps,
    },
    service: service,
  }

  var target = window
  target.gw = Object.assign(target.gw || {}, gw)
  window.dispatchEvent(new CustomEvent('gw:ready', { detail: Object.assign({}, context) }))
}`
