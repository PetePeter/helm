/**
 * noble-adapter — the single point where the real radio is loaded.
 *
 * `@stoprocent/noble` is a native module: requiring it touches the Bluetooth
 * stack, so it is loaded lazily and only when a BLE link is actually wanted.
 * Everything else in Helm depends on the `NobleApi` interface instead, which is
 * what keeps `BleLinkClient` testable without hardware.
 *
 * No `@electron/rebuild` step is needed — noble ships N-API prebuilds resolved
 * by node-gyp-build, and N-API is ABI-stable across Electron (P-0733 finding).
 * On Windows 10 build ≥ 15063 noble routes to the real WinRT bindings, so the
 * central role works through the normal Windows Bluetooth stack with no driver
 * change. The peripheral role does NOT — that is why the phone serves GATT.
 */

import { createRequire } from 'node:module';
import type { NobleApi } from './ble-link-client';

const require_ = createRequire(import.meta.url);

let cached: NobleApi | null = null;

/**
 * Load the real noble central. Throws if the native module is unavailable —
 * callers decide whether that degrades the app or disables the mobile link.
 */
export function loadNoble(): NobleApi {
  if (!cached) {
    const loaded = require_('@stoprocent/noble') as { default?: NobleApi } & NobleApi;
    cached = loaded.default ?? loaded;
  }
  return cached;
}
