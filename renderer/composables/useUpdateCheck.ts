/**
 * Self-update composable — the renderer half of the launch-time check.
 *
 * bootstrap() fires checkForAppUpdate() a few seconds after the app is ready
 * unless the user set update checks to 'manual'; Settings → Updates →
 * "Check now" calls checkForAppUpdateNow() in either mode.
 * A launch-found release is offered by a persistent toast (the user may be
 * anywhere); a "Check now" find is offered in place, as an Update button beside
 * Check now (`updateOffer` / `installUpdate`). Either way, accepting downloads,
 * silent-installs, and restarts Helm (sessions land in
 * the recycle bin and restore-with-resume on relaunch). Every failure path is
 * a quiet no-op or a toast — an offline machine must never see an error.
 */

import { ref } from 'vue';
import { useToast } from './useToast';
import { eventsClient, updateClient } from '../ipc/clients';

const UPDATE_TOAST_KEY = 'helm-update';
const UPDATE_ERROR_TOAST_KEY = 'helm-update-error';
/** How long to wait after startup before asking GitHub (let resume settle). */
const CHECK_DELAY_MS = 5_000;
/** Set while an install is in flight so repeated toast clicks are no-ops. */
let installing = false;
/** The current offer: drives the Updates tab's button and a failed install's retry. */
export const updateOffer = ref<{ version: string; installerUrl: string } | null>(null);
/** Install progress for the Updates tab ('' when idle). */
export const installStatus = ref('');
/** Whether the offer is on a toast (launch check) — progress then mirrors to it. */
let offeredByToast = false;

export function checkForAppUpdate(): void {
  setTimeout(() => void runLaunchCheck(), CHECK_DELAY_MS);
}

async function runLaunchCheck(): Promise<void> {
  try {
    if ((await updateClient.updateGetMode()) === 'manual') return;
  } catch {
    return; // can't read the setting — respect a possible 'manual' by not checking
  }
  const result = await fetchUpdate();
  if (result?.update && result.packaged) offerByToast(result.update.version, result.update.installerUrl);
}

/**
 * User-initiated check. Unlike the launch check it always answers — the user
 * asked, so silence would read as "broken". Returns a one-line status.
 */
export async function checkForAppUpdateNow(): Promise<string> {
  const result = await fetchUpdate();
  if (!result) return 'Could not check for updates';
  if (!result.update) return `Helm v${result.current} is up to date`;
  if (!result.packaged) return `v${result.update.version} is available (dev build — install from a packaged app)`;
  // Offered in place (the Updates tab's button), not by toast: the user is right
  // there. A launch toast still up for the same offer is retired, not duplicated.
  if (offeredByToast) {
    const { toasts, removeToast } = useToast();
    const toast = toasts.find(t => t.key === UPDATE_TOAST_KEY);
    if (toast) removeToast(toast.id);
    offeredByToast = false;
  }
  updateOffer.value = { version: result.update.version, installerUrl: result.update.installerUrl };
  return `Helm v${result.update.version} is available`;
}

/** Accept the current offer. Repeated calls while installing are no-ops. */
export function installUpdate(): void {
  if (updateOffer.value) void runInstall(updateOffer.value.installerUrl);
}

function offerByToast(version: string, installerUrl: string): void {
  updateOffer.value = { version, installerUrl };
  offeredByToast = true;
  const { addToast } = useToast();
  addToast({
    key: UPDATE_TOAST_KEY,
    message: `Helm v${version} available — click to update`,
    type: 'info',
    persistent: true,
    onClick: () => void runInstall(installerUrl),
  });
}

async function fetchUpdate() {
  try {
    return await updateClient.updateCheck();
  } catch {
    return null; // IPC trouble — the launch check stays silent
  }
}

/** Progress goes to the Updates tab always, and to the offer toast when there is one. */
function showProgress(message: string): void {
  installStatus.value = message;
  if (offeredByToast) useToast().addToast({ key: UPDATE_TOAST_KEY, message, type: 'info', persistent: true });
}

async function runInstall(installerUrl: string): Promise<void> {
  if (installing) return; // second click while already in flight
  installing = true;
  showProgress('Downloading update…');

  const unsubscribe = eventsClient.onUpdateProgress((progress: {
    stage: 'downloading' | 'restarting' | 'failed';
    percent: number;
    error?: string;
  }) => {
    if (progress.stage === 'downloading') {
      showProgress(`Downloading update… ${progress.percent}%`);
    } else if (progress.stage === 'failed') {
      reportFailure(progress.error ?? 'unknown error');
    }
    // 'restarting': leave the persistent toast as-is; the app quits within a
    // second, so the message below is the last thing on screen.
  });

  try {
    const result = await updateClient.updateInstall(installerUrl);
    if (!result.success) {
      reportFailure(result.error ?? 'unknown error');
      return;
    }
    showProgress('Installing & restarting Helm…');
  } catch (error) {
    reportFailure(String(error));
  } finally {
    unsubscribe();
  }
}

/** A failed install must not cost the user the update: show why, keep the retry. */
function reportFailure(reason: string): void {
  installing = false;
  installStatus.value = `Update failed: ${reason}`;
  useToast().addToast({ key: UPDATE_ERROR_TOAST_KEY, message: `Update failed: ${reason}`, type: 'error', duration: 8000 });
  if (offeredByToast && updateOffer.value) offerByToast(updateOffer.value.version, updateOffer.value.installerUrl);
}
