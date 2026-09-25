/**
 * Self-update composable — the renderer half of the launch-time check.
 *
 * bootstrap() fires checkForAppUpdate() a few seconds after the app is ready
 * unless the user set update checks to 'manual'; Settings → Updates →
 * "Check now" calls checkForAppUpdateNow() in either mode.
 * When a newer packaged release exists, a persistent toast offers the update;
 * clicking it downloads, silent-installs, and restarts Helm (sessions land in
 * the recycle bin and restore-with-resume on relaunch). Every failure path is
 * a quiet no-op or a toast — an offline machine must never see an error.
 */

import { useToast } from './useToast';
import { eventsClient, updateClient } from '../ipc/clients';

const UPDATE_TOAST_KEY = 'helm-update';
const UPDATE_ERROR_TOAST_KEY = 'helm-update-error';
/** How long to wait after startup before asking GitHub (let resume settle). */
const CHECK_DELAY_MS = 5_000;
/** Set while an install is in flight so repeated toast clicks are no-ops. */
let installing = false;
/** The current offer, so a failed install can restore the retry toast. */
let offer: { version: string; installerUrl: string } | null = null;

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
  if (result?.update && result.packaged) offerUpdate(result.update.version, result.update.installerUrl);
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
  offerUpdate(result.update.version, result.update.installerUrl);
  return `Helm v${result.update.version} is available`;
}

function offerUpdate(version: string, installerUrl: string): void {
  offer = { version, installerUrl };
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

async function runInstall(installerUrl: string): Promise<void> {
  if (installing) return; // second click on the toast while already in flight
  installing = true;
  const { addToast } = useToast();
  addToast({ key: UPDATE_TOAST_KEY, message: 'Downloading update…', type: 'info', persistent: true });

  const unsubscribe = eventsClient.onUpdateProgress((progress: {
    stage: 'downloading' | 'restarting' | 'failed';
    percent: number;
    error?: string;
  }) => {
    if (progress.stage === 'downloading') {
      addToast({ key: UPDATE_TOAST_KEY, message: `Downloading update… ${progress.percent}%`, type: 'info', persistent: true });
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
    addToast({ key: UPDATE_TOAST_KEY, message: 'Installing & restarting Helm…', type: 'info', persistent: true });
  } catch (error) {
    reportFailure(String(error));
  } finally {
    unsubscribe();
  }
}

/** A failed install must not cost the user the update: show why, keep the retry. */
function reportFailure(reason: string): void {
  installing = false;
  const { addToast } = useToast();
  addToast({ key: UPDATE_ERROR_TOAST_KEY, message: `Update failed: ${reason}`, type: 'error', duration: 8000 });
  if (offer) offerUpdate(offer.version, offer.installerUrl);
}
