import { createHash } from 'node:crypto'
import { DEFAULT_APP_ID, CMS_SETTINGS_DOC_ID } from '@/lib/contracts/app-config'
import type { ObjectRecord } from '@/lib/contracts/objects'

/**
 * Dev-only fixture site (C4 deliverable: working render path for a fake site).
 *
 * Enabled with `GW_DEV_FIXTURES=1` — the resolver stack then reads this data
 * instead of Firestore (never used in production). Fixture hostNames:
 * `localhost`, `site-a.test`. Preview secret: `demo-preview`
 * (`?gw-preview=demo-preview`).
 */

export const FIXTURE_TENANT_ID = 'fixture-tenant'
export const FIXTURE_APP_ID = DEFAULT_APP_ID
export const FIXTURE_FOLDER_ID = 'site-a'
export const FIXTURE_PREVIEW_SECRET = 'demo-preview'

const pageId = (id: string, slug: string, contentId?: string): ObjectRecord => ({
  id,
  slug,
  contentId: contentId ?? `${id}-content`,
  name: slug,
  cmsObjectType: FIXTURE_APP_ID,
  typeId: FIXTURE_FOLDER_ID,
  meta: { language: 'en' },
  data: { status: 'published' },
})

export const fixtureObjects: ObjectRecord[] = [
  // Site settings (Section 7.4) — reserved slug.
  {
    id: 'settings-site-a',
    slug: 'default-settings',
    name: 'Site A settings',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      hostNames: ['localhost', 'site-a.test'],
      primaryHost: 'site-a.test',
      defaultLanguage: 'en',
      previewSecret: FIXTURE_PREVIEW_SECRET,
      currency: 'USD',
      sharedCss: '.gw-shared-fixture-note { color: #111263; }',
      theme: {
        colors: { primary: '#111263' },
        cssVariables: { '--gw-radius': '12px' },
        cssClasses: ['fixture-theme'],
      },
      headCode: 'window.gwHeadCodeRan = true;',
      bodyStartCode: '<div id="body-start-marker">body-start</div>',
      bodyEndCode: '<div id="body-end-marker">body-end</div>',
      plugins: {},
      webSettings: { sitemap: { include: 'yes' } },
    },
  },
  // Chrome (Section 7.4) — reserved slugs.
  {
    id: 'header-site-a',
    slug: 'default-header',
    name: 'Site A header',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html: '<header data-testid="fixture-header">Fixture Header</header>',
          css: '.fixture-header-note { color: #111263; }',
        },
      },
    },
  },
  {
    id: 'footer-site-a',
    slug: 'default-footer',
    name: 'Site A footer',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      status: 'published',
      htmlPage: { code: { html: '<footer data-testid="fixture-footer">Fixture Footer</footer>' } },
    },
  },
  // Pages.
  {
    ...pageId('home-page', 'home-page', 'home-content'),
    name: 'Fixture Home',
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html:
            '<main data-testid="fixture-home"><h1>Fixture Home</h1>' +
            '<a data-ic-nav-href="/about" id="nav-about">About</a>' +
            '<form data-gw-form id="smoke-form" class="mt-4">' +
            '<input name="email" type="email" required placeholder="Email">' +
            '<input name="gw_hp" data-gw-honeypot style="display:none">' +
            '<span data-gw-form-status></span>' +
            '<button type="submit">Send</button>' +
            '</form></main>',
          css: '.fixture-home { color: var(--gw-color-primary, #000); }',
          js: [
            'window.gwFixtureHomeRan = (window.gwFixtureHomeRan || 0) + 1;',
            'function gwFixtureHomeFn() { return "hoisted"; }',
            // gw SDK smoke (C5): storage (host-scoped) + formatting.
            'window.gw.storage.set("smoke-visited", "yes");',
            'window.gwSmokeStored = window.gw.storage.get("smoke-visited");',
            'window.gwSmokeCurrency = window.gw.formatCurrency(12.5);',
            'window.gw.forms.bind();',
          ].join('\n'),
        },
      },
    },
    seo: {
      schemaItems: [{ id: 'seo-home', type: 'WebPage', json: '{"@type":"WebPage","name":"Home"}' }],
      metaTitle: 'Fixture Home',
      metaDesc: 'Fixture home page',
      metaRobots: 'index, follow',
      canonicalUrl: 'https://site-a.test/',
    },
  },
  {
    ...pageId('about', 'about'),
    name: 'Fixture About',
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html:
            '<main data-testid="fixture-about"><h2>About</h2>' +
            '<a data-ic-nav-href="/menu-items/menu-1" id="nav-product">Menu item</a></main>',
          js: 'window.gwFixtureAboutRan = (window.gwFixtureAboutRan || 0) + 1;',
        },
      },
    },
    seo: { metaTitle: 'Fixture About' },
  },
  {
    ...pageId('draft-page', 'draft-page'),
    name: 'Fixture Draft',
    data: {
      status: 'draft',
      htmlPage: { code: { html: '<main data-testid="fixture-draft">Draft</main>' } },
    },
  },
  // Object-detail page (Section 24) — another cmsObjectType.
  {
    id: 'menu-1',
    slug: 'menu-1',
    name: 'Menu Item 1',
    cmsObjectType: 'menu-items',
    typeId: 'menu-folder',
    meta: { language: 'en' },
    price: 5, // server cart pricing (C10)
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html: '<main data-testid="fixture-product"><h1>Menu Item 1</h1></main>',
          js: 'window.gwFixtureProductRan = (window.gwFixtureProductRan || 0) + 1;',
        },
      },
    },
    seo: { metaTitle: 'Menu Item 1' },
  },
  {
    id: 'menu-2',
    slug: 'menu-2',
    name: 'Drink',
    cmsObjectType: 'menu-items',
    typeId: 'menu-folder',
    meta: { language: 'en' },
    price: 3,
    data: { status: 'published', htmlPage: { code: { html: '<main>Drink</main>' } } },
    seo: { metaTitle: 'Drink' },
  },
  // Slots for the slot-picker widget (Section 36 appointments sample).
  {
    id: 'slot-1',
    slug: 'slot-1',
    name: 'Slot 10:00',
    cmsObjectType: 'slots',
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    label: '10:00',
    booked: false,
    data: { status: 'published' },
  },
  {
    id: 'slot-2',
    slug: 'slot-2',
    name: 'Slot 11:00',
    cmsObjectType: 'slots',
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    label: '11:00',
    booked: true,
    data: { status: 'published' },
  },
  // Gated page (Section 17 / C9) — requireAuth redirects anonymous visitors.
  {
    ...pageId('account', 'account'),
    name: 'Fixture Account',
    data: {
      status: 'published',
      requireAuth: true,
      htmlPage: {
        code: { html: '<main data-testid="fixture-account"><h1>My Account</h1></main>' },
      },
    },
    seo: { metaTitle: 'Fixture Account' },
  },
  // Widget demo page (Section 35 / C12) — embeds the widget library.
  {
    ...pageId('widgets', 'widgets'),
    name: 'Fixture Widgets',
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html:
            `<main data-testid="fixture-widgets"><h1>Widgets</h1>` +
            `<div data-gw-app="menu" data-gw-config='{"cmsObjectType":"menu-items","folder":"menu-folder","titleField":"name","priceField":"price","addToCart":true}'></div>` +
            `<div data-gw-app="list" data-gw-config='{"cmsObjectType":"menu-items","folder":"menu-folder","fields":[{"field":"name","label":"Name"}],"emptyText":"No items yet"}'></div>` +
            `<div data-gw-app="cart"></div>` +
            `<div data-gw-app="slot-picker" data-gw-config='{"cmsObjectType":"slots","folder":"site-a","labelField":"label","bookedField":"booked"}'></div>` +
            `</main>`,
          js: 'window.gw.apps.mount();',
        },
      },
    },
    seo: { metaTitle: 'Fixture Widgets' },
  },
  // =============================================== C14 sections + list widget
  // Reusable section objects (composed by the /sections page below).
  {
    id: 'section-a',
    slug: 'section-a',
    name: 'Section A',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html: '<section data-testid="fixture-section-a"><h2>Section A</h2></section>',
          css: '.fixture-section-a { border-top: 1px solid #111263; }',
          js: 'window.gwSectionARan = (window.gwSectionARan || 0) + 1;',
        },
      },
    },
  },
  {
    id: 'section-b',
    slug: 'section-b',
    name: 'Section B',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html: '<section data-testid="fixture-section-b"><h2>Section B</h2></section>',
        },
      },
    },
  },
  // Private section — must be SKIPPED by the sections loader.
  {
    id: 'section-private',
    slug: 'section-private',
    name: 'Section Private',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    rules: { publicAccess: 'no' },
    data: {
      status: 'published',
      htmlPage: { code: { html: '<section data-testid="fixture-section-private">Private</section>' } },
    },
  },
  // Sections demo page: A + missing + B + private, then its own content.
  {
    ...pageId('sections', 'sections'),
    name: 'Fixture Sections',
    data: {
      status: 'published',
      sections: [
        { cmsObjectType: FIXTURE_APP_ID, objectId: 'section-a' },
        { cmsObjectType: FIXTURE_APP_ID, objectId: 'section-missing' },
        { cmsObjectType: FIXTURE_APP_ID, objectId: 'section-b' },
        { cmsObjectType: FIXTURE_APP_ID, objectId: 'section-private' },
      ],
      htmlPage: {
        code: {
          html:
            '<main data-testid="fixture-sections"><h1>Sections</h1>' +
            '<div data-testid="fixture-page-own" class="gw-shared-fixture-note">Own content</div>' +
            '</main>',
        },
      },
    },
    seo: { metaTitle: 'Fixture Sections' },
  },
  // ======================================================= C13 pilots
  // Pilot A — restaurant ordering (config + data.html ONLY, no platform code).
  {
    id: 'cat-mains',
    slug: 'cat-mains',
    name: 'Mains',
    cmsObjectType: 'categories',
    typeId: 'menu-folder',
    meta: { language: 'en' },
    data: { status: 'published' },
  },
  {
    ...pageId('restaurant', 'restaurant'),
    name: 'Restaurant Order',
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html:
            '<main data-testid="fixture-restaurant"><h1>Restaurant Order</h1>' +
            '<div id="restaurant-categories" data-testid="restaurant-categories"></div>' +
            `<div data-gw-app="menu" data-gw-config='{"cmsObjectType":"menu-items","folder":"menu-folder","titleField":"name","priceField":"price","addToCart":true}'></div>` +
            '<div data-gw-app="cart"></div>' +
            `<div data-gw-app="checkout-flow" data-gw-config='{"flowId":"restaurant-checkout"}'></div>` +
            '<div id="restaurant-order-status" data-testid="restaurant-order-status"></div>' +
            '</main>',
          js:
            'window.gw.apps.mount();' +
            "window.gw.db.query({ cmsObjectType: 'categories', folder: 'menu-folder', pageSize: 20 }).then(function (res) {" +
            "  var cats = document.getElementById('restaurant-categories');" +
            "  if (cats) cats.textContent = res.items.map(function (c) { return c.name; }).join(', ');" +
            '}).catch(function () {});' +
            // Order-status via subscribe (Section 36): mount it with the id
            // of the order the checkout flow just created.
            'var orderStatusTimer = window.setInterval(function () {' +
            "  if (!document.querySelector('[data-testid=gw-flow-done]')) return;" +
            '  window.clearInterval(orderStatusTimer);' +
            "  fetch('/api/account/orders', { credentials: 'same-origin' }).then(function (r) { return r.json(); }).then(function (data) {" +
            "    var host = document.getElementById('restaurant-order-status');" +
            "    var latest = (data.items || []).filter(function (o) { return o.source === 'restaurant-pilot'; })[0];" +
            '    if (!host || !latest) return;' +
            '    host.innerHTML = \'<div data-gw-app="order-status" data-gw-config=\\\'{\\"orderId\\":\\"\' + latest.id + \'\\"}\\\'></div>\';' +
            '    window.gw.apps.mount(host);' +
            '  }).catch(function () {});' +
            '}, 400);',
        },
      },
    },
    seo: { metaTitle: 'Restaurant Order' },
  },
  {
    id: 'op-create-order',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      status: 'published',
      operationId: 'create-order',
      permission: { roles: ['customer'] },
      transaction: true,
      writes: [
        {
          targetType: 'orders',
          mode: 'create',
          with: {
            customerId: 'user.id',
            status: 'new',
            total: 'payload.total',
            source: 'restaurant-pilot',
          },
        },
      ],
    },
  },
  {
    id: 'flow-restaurant-checkout',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      status: 'published',
      flowId: 'restaurant-checkout',
      steps: [
        {
          id: 'cart',
          dataDefinitions: [
            { field: 'total', type: 'number', label: 'Cart total', required: true },
          ],
          validationRules: [{ field: 'total', rule: 'required' }],
        },
        {
          id: 'delivery',
          dataDefinitions: [
            { field: 'address', type: 'text', label: 'Delivery address', required: true },
          ],
          validationRules: [{ field: 'address', rule: 'required' }],
        },
        { id: 'payment', paymentProvider: 'stripe-test', amountFormula: 'cart.total' },
        { id: 'done', hooks: [{ type: 'operation', operationId: 'create-order' }] },
      ],
    },
  },
  // Pilot B — bus tickets (trips + seat-map + ticket flow + PNR page).
  {
    ...pageId('tickets', 'tickets'),
    name: 'Bus Tickets',
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html:
            '<main data-testid="fixture-tickets"><h1>Bus Tickets</h1>' +
            `<div data-gw-app="search-box" data-gw-config='{"cmsObjectType":"trips","placeholder":"Search trips…"}'></div>` +
            '<div id="trip-links" data-testid="trip-links"></div>' +
            '</main>',
          js:
            'window.gw.apps.mount();' +
            "window.gw.db.query({ cmsObjectType: 'trips', pageSize: 20 }).then(function (res) {" +
            "  var host = document.getElementById('trip-links');" +
            '  if (!host) return;' +
            '  res.items.forEach(function (item) {' +
            "    var a = document.createElement('a');" +
            "    a.href = '/t/bus/' + item.id;" +
            "    a.textContent = item.route + ' — ' + item.price;" +
            "    a.setAttribute('data-testid', 'trip-link');" +
            '    host.appendChild(a);' +
            '    host.appendChild(document.createElement("br"));' +
            '  });' +
            '}).catch(function () {});',
        },
      },
    },
    seo: { metaTitle: 'Bus Tickets' },
  },
  {
    ...pageId('bus-template', 'bus'),
    name: 'Trip template',
    data: {
      status: 'published',
      templateContentType: 'trips',
      htmlPage: {
        code: {
          html: '<main data-testid="fixture-bus-template"><h1>Trip</h1></main>',
        },
      },
    },
  },
  {
    id: 'trip-101',
    slug: 'trip-101',
    name: 'Airport Express',
    cmsObjectType: 'trips',
    typeId: 'bus-a',
    meta: { language: 'en' },
    route: 'Airport Express',
    origin: 'Downtown',
    destination: 'Airport',
    price: 25,
    rows: [
      {
        seats: [
          { id: '1A', booked: false },
          { id: '1B', booked: true },
          { id: '1C', booked: false },
        ],
      },
    ],
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html:
            '<main data-testid="fixture-trip"><h1>Airport Express</h1>' +
            `<div data-gw-app="seat-map" data-gw-config='{"cmsObjectType":"trips","objectId":"trip-101"}'></div>` +
            `<div data-gw-app="checkout-flow" data-gw-config='{"flowId":"ticket-checkout"}'></div>` +
            '<a id="pnr-link" data-ic-nav-href="/pnr" href="/pnr">My tickets</a>' +
            '</main>',
          js: 'window.gw.apps.mount();',
        },
      },
    },
    seo: { metaTitle: 'Airport Express' },
  },
  {
    id: 'op-issue-ticket',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      status: 'published',
      operationId: 'issue-ticket',
      permission: { roles: ['customer'] },
      transaction: true,
      writes: [
        {
          targetType: 'tickets',
          mode: 'create',
          with: {
            customerId: 'user.id',
            tripId: 'payload.tripId',
            seats: 'payload.count',
            passenger: 'payload.name',
            status: 'issued',
          },
        },
      ],
    },
  },
  {
    id: 'flow-ticket-checkout',
    cmsObjectType: FIXTURE_APP_ID,
    typeId: FIXTURE_FOLDER_ID,
    meta: { language: 'en' },
    data: {
      status: 'published',
      flowId: 'ticket-checkout',
      steps: [
        {
          id: 'seats',
          dataDefinitions: [{ field: 'count', type: 'number', label: 'Seats', required: true }],
          validationRules: [{ field: 'count', rule: 'required' }],
        },
        {
          id: 'passengers',
          dataDefinitions: [
            { field: 'name', type: 'text', label: 'Passenger name', required: true },
          ],
          validationRules: [{ field: 'name', rule: 'required' }],
        },
        // Per-seat price formula (Section 31 amountFormula).
        { id: 'payment', paymentProvider: 'stripe-test', amountFormula: 'seats.count * 25' },
        {
          id: 'done',
          hooks: [
            {
              type: 'operation',
              operationId: 'issue-ticket',
              payload: {
                tripId: 'trip-101',
                count: 'steps.seats.count',
                name: 'steps.passengers.name',
              },
            },
          ],
        },
      ],
    },
  },
  {
    ...pageId('pnr', 'pnr'),
    name: 'My Tickets (PNR)',
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html:
            '<main data-testid="fixture-pnr"><h1>My Tickets</h1>' +
            '<div id="pnr-list" data-testid="pnr-list"></div>' +
            '</main>',
          js:
            "fetch('/api/account/tickets', { credentials: 'same-origin' }).then(function (r) {" +
            "  if (!r.ok) throw new Error('tickets failed');" +
            '  return r.json();' +
            '}).then(function (data) {' +
            "  var host = document.getElementById('pnr-list');" +
            '  if (!host) return;' +
            '  if (!data.items || data.items.length === 0) {' +
            "    host.textContent = 'No tickets yet';" +
            '    return;' +
            '  }' +
            '  data.items.forEach(function (t) {' +
            "    var row = document.createElement('p');" +
            "    row.setAttribute('data-testid', 'pnr-row');" +
            "    row.textContent = 'Ticket: ' + t.passenger + ' — ' + t.seats + ' seat(s) — ' + t.status;" +
            '    host.appendChild(row);' +
            '  });' +
            '}).catch(function () {' +
            "  var host = document.getElementById('pnr-list');" +
            "  if (host) host.textContent = 'Sign in to see your tickets';" +
            '});',
        },
      },
    },
    seo: { metaTitle: 'My Tickets' },
  },
  // M10 capability page — /app/<appId> renders a page with slug `app-<appId>`.
  {
    ...pageId('app-booking', 'app-booking'),
    name: 'Booking console',
    data: {
      status: 'published',
      htmlPage: {
        code: {
          html: '<main data-testid="fixture-app-booking"><h1>Booking console</h1></main>',
        },
      },
    },
    seo: { metaTitle: 'Booking console' },
  },
]

/** Settings docs served by the fixture provider (registry + cms-settings). */
export const fixtureSettings: Record<string, Record<string, unknown>> = {
  localhost: {
    tenantConfig: {
      tenantId: FIXTURE_TENANT_ID,
      databaseProvider: 'firestore',
      firebase: { projectId: 'fixture-project' },
      defaultAppId: FIXTURE_APP_ID,
    },
  },
  'site-a.test': {
    tenantConfig: {
      tenantId: FIXTURE_TENANT_ID,
      databaseProvider: 'firestore',
      firebase: { projectId: 'fixture-project' },
      defaultAppId: FIXTURE_APP_ID,
    },
  },
  [CMS_SETTINGS_DOC_ID]: {
    objectTypes: [
      { id: FIXTURE_APP_ID, capabilities: ['website'] },
      { id: 'menu-items', rules: { publicAccess: 'yes' } },
      { id: 'slots', rules: { publicAccess: 'yes' } },
      { id: 'categories', rules: { publicAccess: 'yes' } },
      { id: 'trips', rules: { publicAccess: 'yes' } },
    ],
  },
}

/**
 * Seeded record collections (C9 account-scoping e2e): orders owned by the
 * fixture-auth user `user@example.com` (deterministic uid, see
 * lib/auth/fixture.ts) and one foreign order that must NEVER be returned.
 */
function fixtureUid(email: string): string {
  return `fx-${createHash('sha256').update(email).digest('hex').slice(0, 12)}`
}

export const E2E_AUTH_EMAIL = 'user@example.com'

export const fixtureRecords: Map<string, Record<string, unknown>> = new Map([
  [
    `orders:order-own`,
    { id: 'order-own', customerId: fixtureUid(E2E_AUTH_EMAIL), status: 'new', total: 42 },
  ],
  [
    'orders:order-other',
    { id: 'order-other', customerId: 'fx-someone-else', status: 'new', total: 99 },
  ],
])
