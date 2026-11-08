/**
 * Vue entry point — creates and mounts the Vue app.
 *
 * This is the sole renderer entry point. The legacy main.ts import is removed;
 * all startup logic now lives in the useAppBootstrap composable, called from
 * App.vue's onMounted hook.
 */

import { createApp } from 'vue';
import { createPinia } from 'pinia';
import App from './App.vue';
import { installProfileReload } from './profile-reload.js';
import { profileClient } from './ipc/clients.js';

const DYNAMIC_IMPORT_RELOAD_KEY = 'helm:dynamic-import-reload-attempted';
const DYNAMIC_IMPORT_RELOAD_COOLDOWN_MS = 10_000;

function isDynamicImportFailure(value: unknown): boolean {
  const message = value instanceof Error ? value.message : String(value ?? '');
  return message.includes('Failed to fetch dynamically imported module')
    || message.includes('error loading dynamically imported module')
    || message.includes('Importing a module script failed');
}

function reloadAfterDynamicImportFailure(value: unknown): void {
  if (!isDynamicImportFailure(value)) return;
  const lastReloadAt = Number(sessionStorage.getItem(DYNAMIC_IMPORT_RELOAD_KEY) ?? 0);
  if (Number.isFinite(lastReloadAt) && Date.now() - lastReloadAt < DYNAMIC_IMPORT_RELOAD_COOLDOWN_MS) return;
  sessionStorage.setItem(DYNAMIC_IMPORT_RELOAD_KEY, String(Date.now()));
  window.location.reload();
}

window.addEventListener('error', event => {
  reloadAfterDynamicImportFailure(event.error ?? event.message);
});

window.addEventListener('unhandledrejection', event => {
  reloadAfterDynamicImportFailure(event.reason);
});

// Every window, not just the one hosting the switcher, drops its per-profile state.
installProfileReload(profileClient, () => window.location.reload());

const app = createApp(App);
app.use(createPinia());

// Mount into the #app div (replaces the static layout that was in index.html)
app.mount('#app');
