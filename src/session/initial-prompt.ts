import { parseSequence } from '../input/sequence-parser.js';
import { executeSequenceString } from '../input/sequence-executor.js';
import { logger } from '../utils/logger.js';
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

    if (promptItems.length > 0) {
      logger.info(`[InitialPrompt] Pre-loading ${promptItems.length} item(s) for session ${sessionId}`);

      for (const item of promptItems) {
        if (cancelled) break;
        if (!item) continue;
        await executeItem(item);
      }
    }

    if (!cancelled && config.renameCommand) {
      logger.info(`[InitialPrompt] Sending rename command for session ${sessionId}`);
      await deliver(sessionId, config.renameCommand + '\r');
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
