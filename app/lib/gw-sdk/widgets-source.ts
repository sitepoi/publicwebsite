/**
 * Widget library v1 (Section 35 / C12) — client-side islands registered via
 * gw.apps.register. HARD RULE: widgets are UI + configuration ONLY — data
 * comes from gw.db, writes go through operations/flows; NO vertical business
 * logic lives in the platform.
 *
 * Serialized as an explicit string (ADR-005): plain JS, no backticks, no
 * template interpolation, no type syntax. Served at /gw-widgets.js.
 *
 * Widgets (config-driven, field names come from data-gw-config):
 *   menu, cart, checkout-flow, slot-picker, seat-map, account-dashboard,
 *   rewards, order-status, search-box
 */
export const WIDGETS_SOURCE = String.raw`;(function installGwWidgets() {
  var gw = window.gw
  if (!gw || !gw.apps) return
  // NOTE: no early-return guard here — the bootstrap script re-runs on SPA
  // navigation and each closure must re-register into the SHARED window
  // registry (window.__gwAppFactories). Registration is idempotent.
  window.gwWidgetsLoaded = true
  window.__gwWidgetsLoaded = true

  // ------------------------------------------------------------ dom helpers
  function h(tag, attrs, children) {
    var el = document.createElement(tag)
    if (attrs) {
      for (var key in attrs) {
        if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue
        var value = attrs[key]
        if (value === null || value === undefined) continue
        if (key === 'text') el.textContent = value
        else if (key === 'class') el.className = value
        else el.setAttribute(key, value)
      }
    }
    for (var index = 0; index < (children || []).length; index++) {
      if (children[index]) el.appendChild(children[index])
    }
    return el
  }

  function pick(obj, path) {
    if (obj === null || typeof obj !== 'object') return undefined
    var current = obj
    var parts = String(path || '').split('.')
    for (var index = 0; index < parts.length; index++) {
      if (current === null || typeof current !== 'object') return undefined
      current = current[parts[index]]
    }
    return current
  }

  function showMessage(el, message, testId) {
    el.textContent = ''
    el.appendChild(h('p', { text: message, class: 'gw-widget-error', 'data-testid': testId }))
  }

  function postJson(url, body) {
    return fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    })
  }

  function refreshCartWidgets() {
    if (typeof window.dispatchEvent === 'function') {
      window.dispatchEvent(new CustomEvent('gw:cart-changed'))
    }
  }

  // ------------------------------------------------------------------- menu
  gw.apps.register('menu', function menuWidget(ctx) {
    var config = ctx.config || {}
    var type = config.cmsObjectType
    if (!type) {
      showMessage(ctx.el, 'menu: cmsObjectType is required')
      return
    }
    var fields = Array.isArray(config.fields) && config.fields.length > 0
      ? config.fields
      : [
          { field: config.titleField || 'name', label: 'Name' },
          { field: config.priceField || 'price', label: 'Price' },
        ]

    gw.db
      .query({
        cmsObjectType: type,
        folder: config.folder,
        pageSize: config.limit || 50,
      })
      .then(function renderMenu(result) {
        var list = h('div', { class: 'gw-menu', 'data-testid': 'gw-menu-list' })
        for (let index = 0; index < result.items.length; index++) {
          const item = result.items[index]
          var row = h('div', { class: 'gw-menu-row', 'data-testid': 'gw-menu-row' })
          for (var fieldIndex = 0; fieldIndex < fields.length; fieldIndex++) {
            var spec = fields[fieldIndex]
            row.appendChild(
              h('span', {
                class: 'gw-menu-field',
                text:
                  (spec.label || spec.field) + ': ' + String(pick(item, spec.field) || ''),
              }),
            )
          }
          if (config.addToCart !== false) {
            var add = h('button', { type: 'button', class: 'gw-menu-add', text: 'Add' })
            add.addEventListener('click', function onAdd() {
              postJson('/api/cart', {
                action: 'add',
                item: { cmsObjectType: type, objectId: item.id, qty: 1 },
              })
                .then(function (response) {
                  if (!response.ok) throw new Error('cart failed')
                  refreshCartWidgets()
                })
                .catch(function () {
                  if (typeof gw.notify === 'function') gw.notify('Could not add to cart', { severity: 'error' })
                })
            })
            row.appendChild(add)
          }
          list.appendChild(row)
        }
        ctx.el.textContent = ''
        ctx.el.appendChild(list)
      })
      .catch(function () {
        showMessage(ctx.el, 'menu: failed to load items')
      })
  })

  // ------------------------------------------------------------------- cart
  function renderCart(el, gw) {
    fetch('/api/cart', { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('cart failed')
        return response.json()
      })
      .then(function renderCartBody(data) {
        el.textContent = ''
        if (!data.items || data.items.length === 0) {
          el.appendChild(h('p', { text: 'Cart is empty', 'data-testid': 'gw-cart-empty' }))
          return
        }
        var list = h('div', { class: 'gw-cart', 'data-testid': 'gw-cart-list' })
        for (let index = 0; index < data.items.length; index++) {
          const item = data.items[index]
          var row = h('div', {
            class: 'gw-cart-row',
            text: item.name + ' x ' + item.qty + ' — ' + gw.formatCurrency(item.price * item.qty),
            'data-testid': 'gw-cart-row',
          })
          var remove = h('button', { type: 'button', text: 'Remove' })
          remove.addEventListener('click', function onRemove() {
            postJson('/api/cart', {
              action: 'remove',
              item: { cmsObjectType: item.cmsObjectType, objectId: item.objectId },
            }).then(function () {
              refreshCartWidgets()
            })
          })
          row.appendChild(remove)
          list.appendChild(row)
        }
        list.appendChild(
          h('p', {
            class: 'gw-cart-total',
            text: 'Total: ' + gw.formatCurrency(data.total),
            'data-testid': 'gw-cart-total',
          }),
        )
        el.appendChild(list)
      })
      .catch(function () {
        showMessage(el, 'cart: failed to load')
      })
  }

  gw.apps.register('cart', function cartWidget(ctx) {
    renderCart(ctx.el, ctx.gw)
    var refresh = function onCartChanged() {
      renderCart(ctx.el, ctx.gw)
    }
    window.addEventListener('gw:cart-changed', refresh)
    return function cleanup() {
      window.removeEventListener('gw:cart-changed', refresh)
    }
  })

  // ---------------------------------------------------------- checkout-flow
  gw.apps.register('checkout-flow', function checkoutWidget(ctx) {
    var config = ctx.config || {}
    var flowId = config.flowId
    if (!flowId) {
      showMessage(ctx.el, 'checkout-flow: flowId is required')
      return
    }
    var root = h('div', { class: 'gw-flow', 'data-testid': 'gw-flow' })
    ctx.el.appendChild(root)

    function inputFor(def) {
      var type = def.type === 'number' ? 'number' : def.type === 'boolean' ? 'checkbox' : 'text'
      return h('input', { type: type, name: def.field, required: def.required === true ? '1' : null })
    }

    function renderStep(step) {
      root.textContent = ''
      var defs = step.dataDefinitions || []
      var form = h('form', { class: 'gw-flow-form', 'data-testid': 'gw-flow-form' })
      for (var index = 0; index < defs.length; index++) {
        var def = defs[index]
        form.appendChild(h('label', { text: def.label || def.field }))
        form.appendChild(inputFor(def))
      }
      var submit = h('button', { type: 'submit', text: 'Next' })
      form.appendChild(submit)
      form.addEventListener('submit', function onStep(event) {
        event.preventDefault()
        var values = {}
        var inputs = Array.from(form.querySelectorAll('input'))
        for (var inputIndex = 0; inputIndex < inputs.length; inputIndex++) {
          var input = inputs[inputIndex]
          values[input.name] = input.type === 'number' ? Number(input.value) : input.value
        }
        postJson('/api/flow/' + encodeURIComponent(flowId), { action: 'step', values: values })
          .then(function (response) {
            if (!response.ok) throw new Error('step failed')
            return response.json()
          })
          .then(function (data) {
            if (data.nextStep && data.nextStep.id === 'done') {
              renderDone()
            } else if (data.nextStep) {
              renderStep(data.nextStep)
            }
          })
          .catch(function () {
            showMessage(root, 'checkout-flow: step failed')
          })
      })
      root.appendChild(form)
    }

    function renderDone() {
      root.textContent = ''
      var complete = h('button', {
        type: 'button',
        text: 'Complete order',
        class: 'gw-flow-complete',
      })
      complete.addEventListener('click', function onComplete() {
        postJson('/api/flow/' + encodeURIComponent(flowId), { action: 'complete' })
          .then(function (response) {
            if (!response.ok) throw new Error('complete failed')
            return response.json()
          })
          .then(function (data) {
            root.textContent = ''
            root.appendChild(h('p', { text: 'Completed', 'data-testid': 'gw-flow-done' }))
          })
          .catch(function () {
            showMessage(root, 'checkout-flow: complete failed')
          })
      })
      root.appendChild(complete)
    }

    postJson('/api/flow/' + encodeURIComponent(flowId), { action: 'start' })
      .then(function (response) {
        if (!response.ok) throw new Error('start failed')
        return response.json()
      })
      .then(function (data) {
        renderStep(data.step)
      })
      .catch(function () {
        showMessage(root, 'checkout-flow: could not start')
      })
  })

  // ------------------------------------------------------------ slot-picker
  gw.apps.register('slot-picker', function slotPickerWidget(ctx) {
    var config = ctx.config || {}
    var type = config.cmsObjectType
    if (!type) {
      showMessage(ctx.el, 'slot-picker: cmsObjectType is required')
      return
    }
    var labelField = config.labelField || 'label'
    var bookedField = config.bookedField || 'booked'
    var slotField = config.slotField || 'id'

    gw.db
      .query({ cmsObjectType: type, folder: config.folder, pageSize: config.limit || 100 })
      .then(function renderSlots(result) {
        var list = h('div', { class: 'gw-slots', 'data-testid': 'gw-slots' })
        for (let index = 0; index < result.items.length; index++) {
          const slot = result.items[index]
          var booked = pick(slot, bookedField) === true
          var button = h('button', {
            type: 'button',
            class: 'gw-slot' + (booked ? ' gw-slot-booked' : ''),
            text: String(pick(slot, labelField) || slot.id),
            disabled: booked ? '1' : null,
            'data-testid': 'gw-slot-button',
          })
          button.addEventListener('click', function onPick() {
            if (config.bookOperationId) {
              var payload = {}
              payload[slotField] = pick(slot, slotField) || slot.id
              gw.db
                .operation(config.bookOperationId, payload)
                .then(function () {
                  button.setAttribute('disabled', '1')
                  button.className = 'gw-slot gw-slot-booked'
                })
                .catch(function () {
                  if (typeof gw.notify === 'function') gw.notify('Booking failed', { severity: 'error' })
                })
            } else {
              window.dispatchEvent(
                new CustomEvent('gw:slot-picked', {
                  detail: { slotId: pick(slot, slotField) || slot.id, slot: slot },
                }),
              )
            }
          })
          list.appendChild(button)
        }
        ctx.el.textContent = ''
        ctx.el.appendChild(list)
      })
      .catch(function () {
        showMessage(ctx.el, 'slot-picker: failed to load slots')
      })
  })

  // -------------------------------------------------------------- seat-map
  gw.apps.register('seat-map', function seatMapWidget(ctx) {
    var config = ctx.config || {}
    if (!config.cmsObjectType || !config.objectId) {
      showMessage(ctx.el, 'seat-map: cmsObjectType + objectId are required')
      return
    }
    gw.db
      .get({ cmsObjectType: config.cmsObjectType, objectId: config.objectId })
      .then(function renderSeats(object) {
        if (!object) {
          showMessage(ctx.el, 'seat-map: object not found')
          return
        }
        var rows = pick(object, config.rowsField || 'rows') || []
        var grid = h('div', { class: 'gw-seat-map', 'data-testid': 'gw-seat-map' })
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
          const row = rows[rowIndex]
          var seats = pick(row, config.seatsField || 'seats') || []
          var rowEl = h('div', { class: 'gw-seat-row' })
          for (let seatIndex = 0; seatIndex < seats.length; seatIndex++) {
            const seat = seats[seatIndex]
            var booked = pick(seat, config.bookedField || 'booked') === true
            rowEl.appendChild(
              h('button', {
                type: 'button',
                class: 'gw-seat' + (booked ? ' gw-seat-booked' : ''),
                text: String(pick(seat, config.seatIdField || 'id') || ''),
                disabled: booked ? '1' : null,
              }),
            )
          }
          grid.appendChild(rowEl)
        }
        ctx.el.textContent = ''
        ctx.el.appendChild(grid)
      })
      .catch(function () {
        showMessage(ctx.el, 'seat-map: failed to load')
      })
  })

  // ----------------------------------------------------- account-dashboard
  gw.apps.register('account-dashboard', function accountWidget(ctx) {
    fetch('/api/account/profile', { credentials: 'same-origin' })
      .then(function (response) {
        if (!response.ok) throw new Error('profile failed')
        return response.json()
      })
      .then(function renderAccount(data) {
        var panel = h('div', { class: 'gw-account', 'data-testid': 'gw-account' })
        var user = data.profile && data.profile.user
        panel.appendChild(h('p', { text: user && user.email ? user.email : 'Unknown user' }))
        panel.appendChild(
          h('p', {
            text: 'Roles: ' + String((user && user.roles) || []).replace(/,/g, ', '),
          }),
        )
        return fetch('/api/account/orders', { credentials: 'same-origin' })
          .then(function (response) {
            if (!response.ok) throw new Error('orders failed')
            return response.json()
          })
          .then(function (orders) {
            panel.appendChild(h('p', { text: 'Orders: ' + orders.items.length }))
            ctx.el.textContent = ''
            ctx.el.appendChild(panel)
          })
      })
      .catch(function () {
        var panel = h('div', { class: 'gw-account', 'data-testid': 'gw-account-signin' })
        panel.appendChild(h('p', { text: 'Please sign in to see your account.' }))
        var signIn = h('button', { type: 'button', text: 'Sign in' })
        signIn.addEventListener('click', function () {
          if (typeof gw.login === 'function') gw.login()
        })
        panel.appendChild(signIn)
        ctx.el.textContent = ''
        ctx.el.appendChild(panel)
      })
  })

  // -------------------------------------------------------------- rewards
  gw.apps.register('rewards', function rewardsWidget(ctx) {
    var config = ctx.config || {}
    var type = config.cmsObjectType || 'rewards'
    var user = typeof gw.getUser === 'function' ? gw.getUser() : null
    if (!user) {
      showMessage(ctx.el, 'rewards: sign in to see points', 'gw-rewards-signin')
      return
    }
    var filters = [
      {
        field: config.customerField || 'customerId',
        op: '==',
        value: user.id,
      },
    ]
    gw.db
      .query({ cmsObjectType: type, filters: filters, pageSize: config.limit || 50 })
      .then(function renderRewards(result) {
        var total = 0
        for (let index = 0; index < result.items.length; index++) {
          total += Number(pick(result.items[index], config.pointsField || 'points') || 0)
        }
        ctx.el.textContent = ''
        ctx.el.appendChild(
          h('p', { text: 'Points: ' + total, 'data-testid': 'gw-rewards-total' }),
        )
      })
      .catch(function () {
        showMessage(ctx.el, 'rewards: failed to load')
      })
  })

  // ---------------------------------------------------------- order-status
  gw.apps.register('order-status', function orderStatusWidget(ctx) {
    var config = ctx.config || {}
    var orderId = config.orderId
    if (!orderId) {
      showMessage(ctx.el, 'order-status: orderId is required')
      return
    }
    var statusEl = h('p', { text: 'Loading…', 'data-testid': 'gw-order-status' })
    ctx.el.textContent = ''
    ctx.el.appendChild(statusEl)

    function loadStatus() {
      fetch('/api/account/orders', { credentials: 'same-origin' })
        .then(function (response) {
          if (!response.ok) throw new Error('orders failed')
          return response.json()
        })
        .then(function (data) {
          for (let index = 0; index < data.items.length; index++) {
            if (String(data.items[index].id) === String(orderId)) {
              var status = data.items[index][config.statusField || 'status']
              statusEl.textContent = 'Status: ' + (status === undefined || status === null ? 'unknown' : String(status))
              return
            }
          }
          statusEl.textContent = 'Status: not found'
        })
        .catch(function () {
          statusEl.textContent = 'Status: unavailable'
        })
    }
    loadStatus()
    var unsubscribe = gw.db.subscribe({}, function onChange() {
      loadStatus()
    })
    return unsubscribe
  })

  // ------------------------------------------------------------ search-box
  gw.apps.register('search-box', function searchBoxWidget(ctx) {
    var config = ctx.config || {}
    var type = config.cmsObjectType
    if (!type) {
      showMessage(ctx.el, 'search-box: cmsObjectType is required')
      return
    }
    var box = h('div', { class: 'gw-search', 'data-testid': 'gw-search-box' })
    var input = h('input', {
      type: 'text',
      placeholder: config.placeholder || 'Search…',
      'data-testid': 'gw-search-input',
    })
    var results = h('div', { class: 'gw-search-results', 'data-testid': 'gw-search-results' })
    box.appendChild(input)
    box.appendChild(results)
    ctx.el.textContent = ''
    ctx.el.appendChild(box)

    var timer = null
    input.addEventListener('input', function onInput() {
      if (timer) window.clearTimeout(timer)
      timer = window.setTimeout(function runSearch() {
        var query = input.value.trim()
        if (!query) {
          results.textContent = ''
          return
        }
        var params = new URLSearchParams({ type: type, q: query })
        if (config.lang) params.set('lang', config.lang)
        fetch('/api/search?' + params.toString(), { credentials: 'same-origin' })
          .then(function (response) {
            if (!response.ok) throw new Error('search failed')
            return response.json()
          })
          .then(function (data) {
            results.textContent = ''
            for (let index = 0; index < data.items.length; index++) {
              const item = data.items[index]
              results.appendChild(
                h('p', {
                  text: String(pick(item, config.titleField || 'name') || item.id),
                  class: 'gw-search-hit',
                }),
              )
            }
          })
          .catch(function () {
            results.textContent = ''
          })
      }, 300)
    })

    return function cleanup() {
      if (timer) window.clearTimeout(timer)
    }
  })
})();
`
