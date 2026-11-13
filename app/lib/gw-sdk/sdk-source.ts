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

  // ------------------------------------------------------------ diagnostics
  // Client-side troubleshooting for widget islands. Nothing is sent over the
  // network: events live on window.__gwDiag (ring buffer, 300 entries) and are
  // readable with gw.diag(). Verbose console output (all events) is opt-in:
  //   ?gwdebug=1   or   localStorage.gwDebug = '1'   or   window.GW_DEBUG = true
  // Warnings/errors are ALWAYS printed: an island that never mounted or a
  // failed data call must be visible without extra setup.
  var diagStore = window.__gwDiag
  if (!diagStore || !diagStore.events) {
    diagStore = { events: [], max: 300, enabled: false, audit: null, warnedIslands: {} }
    window.__gwDiag = diagStore
  }
  if (!diagStore.warnedIslands) diagStore.warnedIslands = {}

  function diagnosticsEnabled() {
    try {
      if (window.GW_DEBUG === true) return true
      if (typeof location !== 'undefined' && /(?:[?&])gwdebug=1(?:&|$)/.test(location.search)) {
        return true
      }
      return window.localStorage.getItem('gwDebug') === '1'
    } catch (error) {
      return false
    }
  }
  diagStore.enabled = diagnosticsEnabled()

  function errorTextOf(error) {
    if (!error) return 'unknown error'
    if (typeof error === 'string') return error
    if (error.message) return String(error.message)
    return String(error)
  }

  /** Shape descriptor for a value (key names/counts only - never values). */
  function shapeOf(value) {
    if (value === null) return 'null'
    if (value === undefined) return 'undefined'
    if (Array.isArray(value)) return 'array(' + value.length + ')'
    if (typeof value !== 'object') return typeof value
    var keys = Object.keys(value)
    return 'object(' + keys.length + ': ' + keys.slice(0, 12).join(',') + ')'
  }

  function keysOf(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return []
    return Object.keys(value).slice(0, 20)
  }

  function diagnostics(eventName, details) {
    var entry = { at: new Date().toISOString(), event: eventName }
    if (details) {
      var detailKeys = Object.keys(details)
      for (var detailIndex = 0; detailIndex < detailKeys.length; detailIndex++) {
        entry[detailKeys[detailIndex]] = details[detailKeys[detailIndex]]
      }
    }
    diagStore.events.push(entry)
    while (diagStore.events.length > diagStore.max) diagStore.events.shift()
    try {
      window.dispatchEvent(new CustomEvent('gw:diag', { detail: entry }))
    } catch (eventError) {
      /* CustomEvent unavailable */
    }
    var alwaysPrint = entry.level === 'warn' || entry.level === 'error'
    if (diagStore.enabled || alwaysPrint) {
      var consoleMethod = entry.level === 'warn' ? 'warn' : entry.level === 'error' ? 'error' : 'info'
      try {
        console[consoleMethod]('[gw] ' + eventName, details || {})
      } catch (consoleError) {
        /* console unavailable */
      }
    }
    return entry
  }

  /** Fetch wrapper: records the call and network failures (no payload values). */
  async function diagFetch(eventName, url, init, details) {
    var startedAt = Date.now()
    diagnostics(
      eventName + '.start',
      Object.assign({ url: url, method: init && init.method ? init.method : 'GET' }, details || {}),
    )
    try {
      return init ? await fetch(url, init) : await fetch(url)
    } catch (networkError) {
      diagnostics(eventName + '.network-error', {
        level: 'error',
        url: url,
        message: errorTextOf(networkError),
        durationMs: Date.now() - startedAt,
      })
      throw networkError
    }
  }

  /** The server error code of a failed response (short-circuits nothing). */
  async function diagErrorCode(response) {
    try {
      if (!response || typeof response.clone !== 'function') return undefined
      var parsed = await response.clone().json()
      if (parsed && typeof parsed.error === 'string') return parsed.error
      if (parsed && typeof parsed.message === 'string') return parsed.message
    } catch (parseError) {
      /* non-JSON error body */
    }
    return undefined
  }

  // Same-origin API observer: every /api/* response (data, cms relay, write,
  // appstore, external) is recorded with its URL, status and response SHAPE
  // (key names + counts, never values). This answers "which request returned
  // this object?" without DevTools Network. Behavior is unchanged.
  if (typeof window.fetch === 'function' && !window.fetch.__gwObserved) {
    var originalFetch = window.fetch.bind(window)
    var observedFetch = function observedFetch(input, init) {
      var requestUrl =
        typeof input === 'string'
          ? input
          : input && typeof input.url === 'string'
            ? input.url
            : String(input)
      var requestMethod =
        (init && init.method) || (input && typeof input.method === 'string' ? input.method : 'GET')
      var isApiRequest =
        requestUrl.indexOf('/api/') === 0 ||
        (typeof location !== 'undefined' && requestUrl.indexOf(location.origin + '/api/') === 0)
      var startedAt = Date.now()
      var runFetch = function runFetch() {
        return init ? originalFetch(input, init) : originalFetch(input)
      }
      if (!isApiRequest) return runFetch()
      return runFetch().then(
        function onResponse(response) {
          try {
            var copy = typeof response.clone === 'function' ? response.clone() : null
            if (copy) {
              copy
                .text()
                .then(function onBody(text) {
                  var bodyShape = 'non-json'
                  var bodyKeys = []
                  try {
                    var parsedBody = JSON.parse(text)
                    bodyShape = shapeOf(parsedBody)
                    bodyKeys = keysOf(parsedBody)
                  } catch (parseError) {
                    /* non-JSON response */
                  }
                  diagnostics('http.response', {
                    url: requestUrl,
                    method: requestMethod,
                    status: response.status,
                    durationMs: Date.now() - startedAt,
                    bytes: text.length,
                    shape: bodyShape,
                    keys: bodyKeys,
                  })
                })
                .catch(function ignoreBodyError() {})
            }
          } catch (observeError) {
            /* observing must never affect the response */
          }
          return response
        },
        function onNetworkError(networkError) {
          diagnostics('http.network-error', {
            url: requestUrl,
            method: requestMethod,
            message: errorTextOf(networkError),
            durationMs: Date.now() - startedAt,
          })
          throw networkError
        },
      )
    }
    observedFetch.__gwObserved = true
    window.fetch = observedFetch
  }

  // XHR observer (legacy tool code): same /api/* shape capture as fetch.
  if (
    typeof XMLHttpRequest !== 'undefined' &&
    XMLHttpRequest.prototype &&
    !XMLHttpRequest.prototype.__gwObserved
  ) {
    var originalXhrOpen = XMLHttpRequest.prototype.open
    var originalXhrSend = XMLHttpRequest.prototype.send
    XMLHttpRequest.prototype.open = function observedOpen(method, url) {
      this.__gwRequestMethod = method
      this.__gwRequestUrl = url
      return originalXhrOpen.apply(this, arguments)
    }
    XMLHttpRequest.prototype.send = function observedSend() {
      var observedRequest = this
      try {
        observedRequest.addEventListener('loadend', function onRequestDone() {
          var xhrUrl = String(observedRequest.__gwRequestUrl || '')
          var xhrIsApiRequest =
            xhrUrl.indexOf('/api/') === 0 ||
            (typeof location !== 'undefined' && xhrUrl.indexOf(location.origin + '/api/') === 0)
          if (!xhrIsApiRequest) return
          var xhrText = ''
          try {
            xhrText = observedRequest.responseText || ''
          } catch (readError) {
            xhrText = ''
          }
          var xhrShape = 'non-json'
          var xhrKeys = []
          try {
            var xhrBody = JSON.parse(xhrText)
            xhrShape = shapeOf(xhrBody)
            xhrKeys = keysOf(xhrBody)
          } catch (parseError) {
            /* non-JSON response */
          }
          diagnostics('http.response', {
            url: xhrUrl,
            method: String(observedRequest.__gwRequestMethod || 'GET'),
            status: observedRequest.status,
            bytes: xhrText.length,
            shape: xhrShape,
            keys: xhrKeys,
            via: 'xhr',
          })
        })
      } catch (observeError) {
        /* observing must never affect the request */
      }
      return originalXhrSend.apply(this, arguments)
    }
    XMLHttpRequest.prototype.__gwObserved = true
  }

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
  async function writeErrorText(response) {
    try {
      var parsed = await response.json()
      if (parsed && typeof parsed.error === 'string') return parsed.error
      if (parsed && typeof parsed.message === 'string') return parsed.message
    } catch (error) {
      /* non-JSON error body */
    }
    return 'write failed with status ' + response.status
  }

  function querySummary(params) {
    return {
      cmsObjectType: params && params.cmsObjectType ? String(params.cmsObjectType) : '',
      filterCount: params && params.filters && params.filters.length ? params.filters.length : 0,
      pageSize: params && params.pageSize ? params.pageSize : undefined,
      language: params && params.language ? params.language : undefined,
    }
  }

  var db = {
    query: async function query(params) {
      var summary = querySummary(params)
      var response = await diagFetch('db.query', '/api/data/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }, summary)
      if (!response.ok) {
        diagnostics('db.query.failed', {
          level: 'error',
          status: response.status,
          error: await diagErrorCode(response),
          cmsObjectType: summary.cmsObjectType,
          hint: 'see server log event data-api-query for the gate that refused it',
        })
        throw new Error('gw.db.query failed with status ' + response.status)
      }
      var result = await response.json()
      diagnostics('db.query.ok', {
        status: response.status,
        cmsObjectType: summary.cmsObjectType,
        itemCount: result && result.items ? result.items.length : 0,
        total: result && typeof result.total === 'number' ? result.total : undefined,
        firstItemShape:
          result && result.items && result.items[0] ? shapeOf(result.items[0]) : 'none',
        firstItemKeys:
          result && result.items && result.items[0] ? keysOf(result.items[0]) : [],
      })
      return result
    },
    get: async function get(params) {
      var url = '/api/data/' + encodeURIComponent(params.cmsObjectType) + '/' + encodeURIComponent(params.objectId)
      var response = await diagFetch('db.get', url, undefined, {
        cmsObjectType: params.cmsObjectType,
        objectId: params.objectId,
      })
      if (response.status === 404) {
        // 404 is ambiguous by design (gw.db.get returns null): record WHY.
        diagnostics('db.get.not-found', {
          cmsObjectType: params.cmsObjectType,
          objectId: params.objectId,
          error: await diagErrorCode(response),
        })
        return null
      }
      if (!response.ok) {
        diagnostics('db.get.failed', {
          level: 'error',
          status: response.status,
          error: await diagErrorCode(response),
          cmsObjectType: params.cmsObjectType,
          objectId: params.objectId,
        })
        throw new Error('gw.db.get failed with status ' + response.status)
      }
      var record = await response.json()
      diagnostics('db.get.ok', {
        cmsObjectType: params.cmsObjectType,
        objectId: params.objectId,
        shape: shapeOf(record),
        keys: keysOf(record),
      })
      return record
    },
    operation: async function operation(name, payload, options) {
      var body = { operation: name, payload: payload }
      if (options && options.idempotencyKey) body.idempotencyKey = options.idempotencyKey
      var response = await diagFetch('db.operation', '/api/data/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, { operation: name })
      if (!response.ok) {
        diagnostics('db.operation.failed', {
          level: 'error',
          status: response.status,
          operation: name,
          error: await diagErrorCode(response),
        })
        throw new Error('gw.db.operation failed with status ' + response.status)
      }
      return response.json()
    },
    create: async function create(params) {
      // T-43 write-back: same-origin relay → CMS v2 create (key server-side).
      var url = '/api/write/objects/' + encodeURIComponent(params.cmsObjectType)
      var headers = { 'Content-Type': 'application/json' }
      if (params.idempotencyKey) headers['Idempotency-Key'] = params.idempotencyKey
      var response = await diagFetch('db.create', url, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ data: params.data }),
      }, { cmsObjectType: params.cmsObjectType })
      if (!response.ok) {
        var createError = await writeErrorText(response)
        diagnostics('db.create.failed', {
          level: 'error',
          status: response.status,
          error: createError,
          cmsObjectType: params.cmsObjectType,
        })
        return { ok: false, status: response.status, error: createError }
      }
      diagnostics('db.create.ok', { cmsObjectType: params.cmsObjectType })
      return { ok: true, object: await response.json() }
    },
    update: async function update(params) {
      // T-43 write-back: PATCH relay — only objects the public channel
      // created pass the CMS ownership marker check. Delete is never exposed.
      var url =
        '/api/write/objects/' +
        encodeURIComponent(params.cmsObjectType) +
        '/' +
        encodeURIComponent(params.objectId)
      var body = { data: params.data }
      if (params.version !== undefined) body.version = params.version
      var response = await diagFetch('db.update', url, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, { cmsObjectType: params.cmsObjectType, objectId: params.objectId })
      if (!response.ok) {
        var updateError = await writeErrorText(response)
        diagnostics('db.update.failed', {
          level: 'error',
          status: response.status,
          error: updateError,
          cmsObjectType: params.cmsObjectType,
          objectId: params.objectId,
        })
        return { ok: false, status: response.status, error: updateError }
      }
      diagnostics('db.update.ok', {
        cmsObjectType: params.cmsObjectType,
        objectId: params.objectId,
      })
      return { ok: true, object: await response.json() }
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
    'list',
  ]
  var widgetsLoading = false
  var widgetsLoaded = false
  var widgetsQueue = []

  // Widget island SSR contract: configSchema per app-store widget name (from
  // the bootstrap context) — defaults fill missing config keys at mount.
  var appSchemas = context.appSchemas || {}

  function applySchemaDefaults(config, schema) {
    if (!schema || typeof schema !== 'object') return config
    var properties = schema.properties
    if (!properties || typeof properties !== 'object') return config
    var result = {}
    var configKeys = Object.keys(config)
    for (var c = 0; c < configKeys.length; c++) result[configKeys[c]] = config[configKeys[c]]
    var schemaKeys = Object.keys(properties)
    for (var s = 0; s < schemaKeys.length; s++) {
      var key = schemaKeys[s]
      var definition = properties[key]
      if (
        result[key] === undefined &&
        definition &&
        typeof definition === 'object' &&
        definition.default !== undefined
      ) {
        result[key] = definition.default
      }
    }
    return result
  }

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
        if (el.getAttribute('data-gw-pending')) return 'builtin'
        el.setAttribute('data-gw-pending', '1')
        diagnostics('app.mount', { name: name, kind: 'builtin' })
        loadWidgets(function afterWidgets() {
          el.removeAttribute('data-gw-pending')
          mountOne(el)
        })
        return 'builtin'
      }
      // Tool-style widget (website-html-tool publish contract): no
      // gw.apps.register call - it boots through the window.tool shim
      // (onReady). The SSR layer marks known islands data-gw-ssr
      // "1"/"template"/"client"; those mount silently here and the queued
      // tool callbacks are flushed ONCE per page after the mount pass.
      var ssrMode = el.getAttribute('data-gw-ssr')
      if (ssrMode === '1' || ssrMode === 'template' || ssrMode === 'client') {
        var alreadyMounted = el.getAttribute('data-gw-mounted') === '1'
        var toolConfig = {}
        var toolRaw = el.getAttribute('data-gw-config')
        if (toolRaw) {
          try {
            toolConfig = JSON.parse(toolRaw)
          } catch (toolParseError) {
            console.warn(
              '[gw] invalid data-gw-config JSON on "' + name + '" — tool mounts with {}',
              toolParseError,
            )
            diagnostics('app.config-invalid', { level: 'warn', name: name, kind: 'tool' })
          }
        }
        // ALWAYS refresh the active tool config, even when a previous pass
        // already marked the island: onReady hands these fields to the tool,
        // and the page/footer/header mounts share this one shim.
        toolFields = applySchemaDefaults(toolConfig, appSchemas[name])
        if (!alreadyMounted) {
          el.setAttribute('data-gw-mounted', '1')
          diagnostics('app.mount', {
            name: name,
            kind: 'tool',
            ssrMode: ssrMode,
            configKeys: Object.keys(toolFields),
          })
        }
        return 'tool'
      }
      // The island is in the page but nothing can mount it: this is the
      // "no network request at all" failure mode (no catalog code served).
      diagnostics('app.mount-missing', {
        level: 'warn',
        name: name,
        ssrMode: ssrMode || 'unset',
        hint:
          'the island has no catalog record (ssr=none) or no gw.apps.register — the widget code never ran',
      })
      el.dispatchEvent(
        new CustomEvent('gw:app-error', {
          detail: { name: name, message: 'app not registered' },
          bubbles: true,
        }),
      )
      return 'missing'
    }
    if (el.getAttribute('data-gw-mounted')) return 'factory'
    el.setAttribute('data-gw-mounted', '1')

    var config = {}
    var raw = el.getAttribute('data-gw-config')
    if (raw) {
      try {
        config = JSON.parse(raw)
      } catch (parseError) {
        // Invalid JSON is NOT fatal: the island mounts with {} and a warning
        // (widget island SSR contract, acceptance E) — the page is unaffected.
        console.warn(
          '[gw] invalid data-gw-config JSON on "' + name + '" — mounting with {}',
          parseError,
        )
        diagnostics('app.config-invalid', { level: 'warn', name: name, kind: 'factory' })
        el.dispatchEvent(
          new CustomEvent('gw:app-error', {
            detail: { name: name, message: 'invalid data-gw-config JSON' },
            bubbles: true,
          }),
        )
        config = {}
      }
    }
    config = applySchemaDefaults(config, appSchemas[name])
    try {
      var cleanup = factory({ el: el, config: config, gw: gw })
      if (typeof cleanup === 'function' && appCleanups) appCleanups.set(el, cleanup)
      diagnostics('app.mount', {
        name: name,
        kind: 'factory',
        configKeys: Object.keys(config),
      })
    } catch (error) {
      diagnostics('app.mount-failed', {
        level: 'error',
        name: name,
        message: errorTextOf(error),
      })
      el.dispatchEvent(
        new CustomEvent('gw:app-error', { detail: { name: name, error: error }, bubbles: true }),
      )
    }
    return 'factory'
  }

  function mountApps(root) {
    var scope = root || document
    var elements = Array.from(scope.querySelectorAll('[data-gw-app]'))
    var mountedToolIsland = false
    for (var index = 0; index < elements.length; index++) {
      if (mountOne(elements[index]) === 'tool') mountedToolIsland = true
    }
    // Only a pass that actually contains a tool island may flush onReady.
    // Header/footer ContentMounts run the widget scripts too; flushing from
    // one of them handed the tool {fields:{}} before the page island applied
    // its config (observed: widget built no query and made zero API calls).
    if (mountedToolIsland) flushToolReadyQueue()
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
    // SPA navigation: the next page's tool-style widgets boot again via the
    // tool shim, so the once-per-page flush flag is reset on unmount.
    window.__gwToolFlushed = false
  }

  /**
   * Island audit — the fastest way to see WHY a widget did not read data.
   * For every [data-gw-app] it records: catalog ssr mode, mounted flag,
   * whether gw.apps.register ran, config validity. An island that is present
   * but not mounted is reported as island.not-mounted (warn) — that is the
   * "no /api/data request at all" case.
   */
  function auditIslands() {
    if (typeof document === 'undefined') return []
    var islandElements = []
    try {
      islandElements = Array.from(document.querySelectorAll('[data-gw-app]'))
    } catch (queryError) {
      return []
    }
    var summary = []
    for (var islandIndex = 0; islandIndex < islandElements.length; islandIndex++) {
      var island = islandElements[islandIndex]
      var islandName = island.getAttribute('data-gw-app') || ''
      var configRaw = island.getAttribute('data-gw-config') || ''
      var configValid = true
      var parsedConfig = null
      if (configRaw) {
        try {
          parsedConfig = JSON.parse(configRaw)
        } catch (configError) {
          configValid = false
        }
      }
      var configKeys = keysOf(parsedConfig)
      var configShapes = []
      for (var shapeIndex = 0; shapeIndex < configKeys.length; shapeIndex++) {
        var configKey = configKeys[shapeIndex]
        configShapes.push(configKey + '=' + shapeOf(parsedConfig[configKey]))
      }
      summary.push({
        name: islandName,
        ssr: island.getAttribute('data-gw-ssr') || 'unset',
        mounted: island.getAttribute('data-gw-mounted') === '1',
        hasFactory: typeof appFactories[islandName] === 'function',
        builtin: BUILTIN_WIDGETS.indexOf(islandName) >= 0,
        config: configValid ? 'valid' : 'invalid',
        configKeys: configKeys,
        configShapes: configShapes,
        children: island.childNodes.length,
      })
    }
    diagStore.audit = summary
    diagnostics('islands.audit', { count: summary.length, islands: summary })
    for (var reportIndex = 0; reportIndex < summary.length; reportIndex++) {
      var report = summary[reportIndex]
      if (report.mounted || report.builtin) continue
      if (diagStore.warnedIslands[report.name]) continue
      diagStore.warnedIslands[report.name] = true
      diagnostics('island.not-mounted', {
        level: 'warn',
        name: report.name,
        ssr: report.ssr,
        hasFactory: report.hasFactory,
        hint:
          report.ssr === 'none'
            ? 'no catalog record (store or site-local) for this island name — the widget code was never served'
            : 'the island exists but nothing mounted it (no catalog script and no gw.apps.register)',
      })
    }
    return summary
  }

  // ---------------------------------------------------------------- services
  function service(name) {
    return Promise.reject(new Error("gw.service('" + name + "') is not available yet"))
  }

  // T-45 outside-API relay: same-origin POST /api/external/fetch — the host
  // must be listed in the site's externalApiHosts; https-only; no credentials
  // in widget code.
  async function requestFetch(input) {
    var response = await fetch('/api/external/fetch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
    })
    if (!response.ok) {
      var detail = null
      try {
        detail = await response.json()
      } catch (error) {
        /* non-JSON error body */
      }
      return {
        ok: false,
        status: response.status,
        error: (detail && detail.error) || 'requestFetch failed',
        body: '',
      }
    }
    return response.json()
  }

  // ----------------------------------------------------------------- install
  var gw = {
    pageId: context.pageId,
    siteId: context.siteId,
    folderId: context.folderId,
    language: language,
    languageSwitch: context.languageSwitch || [],
    host: host,
    currency: currency,
    ns: context.ns || {},
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
        var isDuplicate = typeof appFactories[name] === 'function'
        appFactories[name] = factory
        diagnostics('app.register', {
          name: name,
          duplicate: isDuplicate,
          factoryType: typeof factory,
        })
      },
      mount: mountApps,
      unmount: unmountApps,
    },
    /** Diagnostics snapshot (island audit + the event ring buffer). */
    diag: function diag() {
      return {
        enabled: diagStore.enabled,
        events: diagStore.events.slice(),
        audit: diagStore.audit,
      }
    },
    auditIslands: auditIslands,
    requestFetch: requestFetch,
    service: service,
  }

  // ------------------------------------------------------------------- tool
  // Publish-side html-tool shim (website-html-tool widget contract Step A.5).
  // Widgets authored as CMS html tools boot through window.tool.onReady(cb).
  // requestAI must NOT exist; requestObjects relays query/get (read) and
  // create/update (write-back via the server-side relay) to the data/write
  // APIs. param()/getFields() read the config of the island being mounted
  // (set by mountOne, flushed once per page).
  var toolReadyQueue = window.__gwToolReadyQueue || (window.__gwToolReadyQueue = [])
  var toolFields = {}

  function flushToolReadyQueue() {
    if (window.__gwToolFlushed) return
    // An empty queue must NOT consume the once-per-page flush: header/footer
    // mount passes run before the page island queues its callback.
    if (toolReadyQueue.length === 0) return
    window.__gwToolFlushed = true
    var queue = toolReadyQueue.slice()
    toolReadyQueue = []
    window.__gwToolReadyQueue = toolReadyQueue
    diagnostics('tool.ready', { callbacks: queue.length })
    for (var index = 0; index < queue.length; index++) {
      try {
        queue[index]({ fields: toolFields })
      } catch (error) {
        console.warn('[gw] tool onReady callback failed', error)
        diagnostics('tool.ready-failed', {
          level: 'error',
          message: errorTextOf(error),
        })
      }
    }
  }

  function toolRequestObjects(action, params, callback) {
    var respond = typeof callback === 'function' ? callback : function noop() {}
    var fail = function fail(error) {
      respond(error || { message: 'requestObjects failed' }, null)
    }
    diagnostics('tool.requestObjects', {
      action: action,
      cmsObjectType: params && params.cmsObjectType ? String(params.cmsObjectType) : '',
      objectId: params && params.objectId ? String(params.objectId) : '',
    })
    try {
      if (action === 'query') {
        gw.db.query(params || {}).then(function done(result) {
          respond(null, result)
        }, fail)
        return
      }
      if (action === 'get') {
        gw.db.get(params || {}).then(function done(result) {
          respond(null, result)
        }, fail)
        return
      }
      if (action === 'create') {
        gw.db.create(params || {}).then(function done(result) {
          respond(null, result)
        }, fail)
        return
      }
      if (action === 'update') {
        gw.db.update(params || {}).then(function done(result) {
          respond(null, result)
        }, fail)
        return
      }
      fail({ message: 'requestObjects supports query/get/create/update only' })
    } catch (error) {
      fail(error)
    }
  }

  window.tool = {
    onReady: function onReady(callback) {
      if (typeof callback === 'function') toolReadyQueue.push(callback)
    },
    onValueChange: function onValueChange() {
      return function unsubscribe() {}
    },
    onReadonlyChange: function onReadonlyChange() {
      return function unsubscribe() {}
    },
    onUserChange: function onUserChange() {
      return function unsubscribe() {}
    },
    getUser: function toolGetUser() {
      return gw.getUser()
    },
    param: function toolParam(name, defaultValue) {
      var value = toolFields[name]
      return value === undefined ? defaultValue : value
    },
    getFields: function toolGetFields() {
      var copy = {}
      var keys = Object.keys(toolFields)
      for (var index = 0; index < keys.length; index++) {
        copy[keys[index]] = toolFields[keys[index]]
      }
      return copy
    },
    notify: function toolNotify() {},
    resize: function toolResize() {},
    isReadOnly: function toolIsReadOnly() {
      return true
    },
    requestObjects: toolRequestObjects,
    requestFetch: function toolRequestFetch(input, callback) {
      var respond = typeof callback === 'function' ? callback : function noop() {}
      gw.requestFetch(input || {}).then(
        function done(result) {
          if (result && result.ok === false) {
            respond({ status: result.status, error: result.error }, null)
          } else {
            respond(null, result)
          }
        },
        function fail(error) {
          respond(error || { message: 'requestFetch failed' }, null)
        },
      )
    },
    // requestAI intentionally ABSENT on the publish side.
  }

  var target = window
  target.gw = Object.assign(target.gw || {}, gw)
  diagnostics('sdk.install', {
    pageId: context.pageId,
    host: host,
    language: language,
    schemaCount: Object.keys(appSchemas).length,
    debug: diagStore.enabled,
  })
  if (diagStore.enabled) {
    try {
      console.info('[gw] diagnostics ON — run gw.diag() for the event log')
    } catch (consoleError) {
      /* console unavailable */
    }
  }
  // Island audit hooks (registered once per page): a mount pass, a content
  // re-mount (SPA nav) and the first load all produce an audit snapshot.
  if (!window.__gwDiagHooks) {
    window.__gwDiagHooks = true
    window.addEventListener('gw:content-ready', function onWidgetContentReady() {
      window.setTimeout(auditIslands, 200)
    })
    if (typeof document !== 'undefined') {
      if (document.readyState === 'complete') {
        window.setTimeout(auditIslands, 2000)
      } else {
        window.addEventListener('load', function onWidgetPageLoad() {
          window.setTimeout(auditIslands, 2000)
        })
      }
    }
  }
  window.dispatchEvent(new CustomEvent('gw:ready', { detail: Object.assign({}, context) }))
}`
