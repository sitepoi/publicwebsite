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
            `<div data-gw-app="cart"></div>` +
            `<div data-gw-app="slot-picker" data-gw-config='{"cmsObjectType":"slots","folder":"site-a","labelField":"label","bookedField":"booked"}'></div>` +
            `</main>`,
          js: 'window.gw.apps.mount();',
        },
      },
    },
    seo: { metaTitle: 'Fixture Widgets' },
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
