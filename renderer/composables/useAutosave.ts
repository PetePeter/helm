/**
 * Settings save model: every edit saves itself. Text fields debounce, toggles
 * and selects save immediately. One shared status feeds the settings footer,
 * so pages never render their own Save button or "saved" banner.
 */
import { getCurrentScope, onScopeDispose, reactive } from 'vue';

export type SaveStatus = 'idle' | 'saving' | 'saved' | 'error';

export const settingsSaveState = reactive<{ status: SaveStatus; message: string }>({ status: 'idle', message: '' });

export const AUTOSAVE_DEBOUNCE_MS = 500;

/**
 * Report a save that a page performs itself (an immediate toggle, an emit the
 * controller handles) on the shared footer status. `save` may return false or
 * throw to report failure; the error is recorded, not rethrown.
 */
export async function trackSave(save: () => Promise<unknown>): Promise<boolean> {
  settingsSaveState.status = 'saving';
  try {
    const result = await save();
    const ok = result !== false;
    settingsSaveState.status = ok ? 'saved' : 'error';
    settingsSaveState.message = ok ? '' : 'Not saved';
    return ok;
  } catch (error) {
    settingsSaveState.status = 'error';
    settingsSaveState.message = error instanceof Error ? error.message : String(error);
    return false;
  }
}

/** `save` may return false to report a rejected save without throwing. */
export function useAutosave(save: () => Promise<unknown>, options: { debounceMs?: number } = {}) {
  const debounceMs = options.debounceMs ?? AUTOSAVE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight = false;
  let again = false;
  const idleWaiters: Array<() => void> = [];

  function resolveIdleWaiters(): void {
    if (timer !== null || inFlight || again) return;
    for (const resolve of idleWaiters.splice(0)) resolve();
  }

  async function run(): Promise<void> {
    timer = null;
    if (inFlight) { again = true; return; }
    inFlight = true;
    try {
      await trackSave(save);
    } finally {
      inFlight = false;
      if (again) {
        again = false;
        if (timer !== null) { clearTimeout(timer); timer = null; }
        void run();
      } else {
        resolveIdleWaiters();
      }
    }
  }

  function schedule(immediate = false): void {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => { void run(); }, immediate ? 0 : debounceMs);
  }

  /** Cancel a pending debounced save without interrupting a save already running. */
  function cancel(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      resolveIdleWaiters();
    }
  }

  /** Run pending edits now and resolve after all queued saves settle. */
  function flush(): Promise<void> {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
      void run();
    }
    if (timer === null && !inFlight && !again) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  if (getCurrentScope()) onScopeDispose(() => { void flush(); });

  return { schedule, flush, cancel };
}
