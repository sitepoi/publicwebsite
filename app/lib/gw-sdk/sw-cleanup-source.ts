/**
 * Self-destructing service worker source (D-DWH-28): the platform registers
 * no service worker, so this worker's only job is to unregister any STALE
 * registration a browser may still carry from the earlier platform.
 */
export const SW_CLEANUP_SOURCE = `self.addEventListener('install', function install() {
  self.skipWaiting()
})

self.addEventListener('activate', function activate(event) {
  event.waitUntil(
    self.registration
      .unregister()
      .catch(function noop() {}),
  )
})
`
