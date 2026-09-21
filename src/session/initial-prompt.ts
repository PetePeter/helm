import { executeSequenceString } from '../input/sequence-executor.js';
import { logger } from '../utils/logger.js';
import { SUBMIT_SETTLE_DELAY_MS } from './delivery-context.js';
import type { SequenceListItem } from '../config/loader.js';

export interface InitialPromptConfig {
  initialPrompt?: SequenceListItem[];
  initialPromptDelay?: number;
  renameCommand?: string;
}

export function scheduleInitialPrompt(
  sessionId: string,
  config: InitialPromptConfig,
  writeToPty: (sessionId: string, data: string) => void,
  deliverTextOrOnComplete?: ((sessionId: string, text: string) => Promise<void>) | (() => void),
  onComplete?: () => void,
  submitToPty?: (sessionId: string) => void | Promise<void>,
  waitForQuiet?: (sessionId: string) => Promise<unknown>,
): (() => void) | null {
  const { initialPrompt, initialPromptDelay = 2000 } = config;
  const promptItems = [...(initialPrompt ?? [])];

  const deliverText = onComplete
    ? (deliverTextOrOnComplete as ((sessionId: string, text: string) => Promise<void>) | undefined)
    : undefined;

  const complete = onComplete ?? (deliverTextOrOnComplete as (() => void) | undefined);
  const deliver = deliverText ?? (async (sid: string, text: string) => { writeToPty(sid, text); });

  if (promptItems.length === 0 && !config.renameCommand) {
    return null;
  }

  let cancelled = false;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  const executeItem = async (item: SequenceListItem) => {
    if (cancelled || !item.sequence || item.sequence.trim() === '') return;

    try {
      await executeSequenceString({
        sessionId,
        input: item.sequence,
        write: writeToPty,
        deliverText: deliver,
        submit: submitToPty,
        isCancelled: () => cancelled,
      });
    } catch (error) {
      // A failing init sequence must not swallow completion: whatever the
      // caller queued behind the prompt (a context prompt, a scheduled task's
      // prompt) is the payload the session actually exists to receive.
      logger.warn(`[InitialPrompt] Item failed for session ${sessionId}: ${error}`);
    }
  };

  const execute = async () => {
    if (cancelled) return;

    // Rename goes FIRST, onto a guaranteed-empty composer, so the slash
    // command lands as its own line. Delivered after the prompt items it
    // glues onto a prompt ending in {NoSend} — the composer holds that
    // unsent text, and the rename's submit then sends one combined message
    // to the model instead of executing the command.
    if (!cancelled && config.renameCommand) {
      // And only onto a SETTLED screen: a SessionStart hook reply re-renders
      // the TUI mid-write, splitting the paste and submitting its tail as a
      // stray user message. waitForQuiet bounds itself and fails open.
      if (waitForQuiet) await waitForQuiet(sessionId);
      if (cancelled) return;
      logger.info(`[InitialPrompt] Sending rename command for session ${sessionId}`);
      await deliver(sessionId, config.renameCommand + '\r');
      // Codex composers can swallow the submit that follows a paste (known
      // wedge): a second bare CR after a settle beat completes it, and is a
      // no-op for CLIs whose composer already submitted.
      await new Promise(resolve => setTimeout(resolve, SUBMIT_SETTLE_DELAY_MS));
      if (!cancelled) writeToPty(sessionId, '\r');
    }

    if (promptItems.length > 0) {
      logger.info(`[InitialPrompt] Pre-loading ${promptItems.length} item(s) for session ${sessionId}`);

      for (const item of promptItems) {
        if (cancelled) break;
        if (!item) continue;
        await executeItem(item);
      }
    }

    if (!cancelled) {
      logger.info(`[InitialPrompt] Complete for session ${sessionId}`);
      complete?.();
    }
  };

  timeoutId = setTimeout(execute, initialPromptDelay);

  return () => {
    cancelled = true;
    if (timeoutId) clearTimeout(timeoutId);
  };
}
