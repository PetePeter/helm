import type { ConfigLoader, SequenceListItem } from '../config/loader.js';
import { parseSubmitSuffix } from '../mcp/submit-suffix.js';
import { logger } from '../utils/logger.js';
import { fillTemplate, sessionTemplateValues } from '../config/template-placeholders.js';
import { scheduleInitialPrompt } from './initial-prompt.js';
import type { DeliveryContext } from './delivery-context.js';
import { deliverPromptSequenceToSession } from './sequence-delivery.js';
import type { SessionManager } from './manager.js';
import type { PtyManager } from './pty-manager.js';

const SUBMIT_DELAY_MS = 200;

/** Shared startup and post-clear path: configured CLI prompt first, reload pointer after it settles. */
export interface SessionReloadPromptParams {
  sessionId: string;
  cliSessionName: string;
  isResume: boolean;
  cfg: ReturnType<ConfigLoader['getCliTypeEntry']> | undefined;
  ptyManager: PtyManager;
  sessionManager: SessionManager;
  configLoader?: ConfigLoader;
  contextText?: string;
  /** Let a caller hold the reload pointer until its delivery gate is ready. */
  armContextText?: (sessionId: string, text: string) => void;
  skipInitialPrompt?: boolean;
  contextDeliveryContext?: DeliveryContext;
  onPromptComplete?: () => void;
  onPromptCancel?: (cancel: () => void) => void;
  fallbackCompleteDelayMs?: number;
  markRestored?: (sessionId: string) => void;
}

export function scheduleSessionReloadPrompt(params: SessionReloadPromptParams): void {
  const deliverText = (sessionId: string, text: string): Promise<void> => {
    const maybeDeliver = (params.ptyManager as Partial<PtyManager>).deliverText;
    if (typeof maybeDeliver === 'function') {
      return maybeDeliver.call(params.ptyManager, sessionId, text);
    }
    params.ptyManager.write(sessionId, text, 'system');
    return Promise.resolve();
  };
  const submit = async (sessionId: string): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
    const submitSuffix = parseSubmitSuffix(params.cfg?.submitSuffix);
    const maybeDeliver = (params.ptyManager as Partial<PtyManager>).deliverText;
    if (typeof maybeDeliver === 'function') {
      return maybeDeliver.call(params.ptyManager, sessionId, '', { submitSuffix });
    }
    params.ptyManager.write(sessionId, submitSuffix, 'system');
  };
  // Rename delivery waits for PTY output to settle (see initial-prompt); a
  // test fake without the method skips the wait, same deal as deliverText.
  const waitForQuiet = async (sessionId: string): Promise<void> => {
    const maybeWait = (params.ptyManager as Partial<PtyManager>).waitForQuiet;
    if (typeof maybeWait === 'function') await maybeWait.call(params.ptyManager, sessionId);
  };

  const resolvedPrompt = resolveInitialPromptConfig(params.cfg, params.cliSessionName);
  const promptConfig = params.skipInitialPrompt ? { ...resolvedPrompt, initialPrompt: undefined } : resolvedPrompt;
  if (params.isResume) {
    params.markRestored?.(params.sessionId);
    if (!promptConfig.renameCommand) return;
    const cancel = scheduleInitialPrompt(
      params.sessionId,
      {
        initialPromptDelay: promptConfig.initialPromptDelay,
        renameCommand: promptConfig.renameCommand,
      },
      (sid, data) => params.ptyManager.write(sid, data, 'system'),
      (sid, text) => deliverText(sid, text),
      undefined,
      submit,
      waitForQuiet,
    );
    if (cancel) params.onPromptCancel?.(cancel);
    return;
  }

  const onComplete = buildPromptCompleteHandler(params, deliverText);
  const cancel = scheduleInitialPrompt(
    params.sessionId,
    promptConfig,
    (sid, data) => params.ptyManager.write(sid, data, 'system'),
    (sid, text) => deliverText(sid, text),
    onComplete ?? (() => undefined),
    submit,
    waitForQuiet,
  );

  if (cancel) {
    params.onPromptCancel?.(cancel);
  } else if (onComplete) {
    const delay = params.fallbackCompleteDelayMs ?? 500;
    if (delay <= 0) onComplete();
    else {
      const timeout = setTimeout(onComplete, delay);
      params.onPromptCancel?.(() => clearTimeout(timeout));
    }
  }
}

export function resolveInitialPromptConfig(
  cliEntry: ReturnType<ConfigLoader['getCliTypeEntry']> | undefined,
  cliSessionName: string,
): { initialPrompt?: SequenceListItem[]; initialPromptDelay?: number; renameCommand?: string } {
  if (!cliEntry) return {};
  const renameCommand = cliEntry.renameCommand && cliSessionName
    ? fillTemplate(cliEntry.renameCommand, sessionTemplateValues(cliSessionName))
    : undefined;
  return {
    initialPrompt: cliEntry.initialPrompt,
    initialPromptDelay: cliEntry.initialPromptDelay,
    renameCommand,
  };
}

function buildPromptCompleteHandler(
  params: SessionReloadPromptParams,
  deliverText: (sessionId: string, text: string) => Promise<void>,
): (() => void) | undefined {
  const contextText = typeof params.contextText === 'string' && params.contextText.length > 0
    ? params.contextText
    : undefined;
  const callbacks: Array<() => void> = [];

  if (contextText) {
    callbacks.push(() => {
      if (params.armContextText) {
        params.armContextText(params.sessionId, contextText);
      } else if (params.configLoader) {
        const target = params.sessionManager.getSession(params.sessionId);
        const cliEntry = target ? params.configLoader.getCliTypeEntry(target.cliType) : undefined;
        const isCodex = cliEntry?.provider === 'codex' || cliEntry?.hooks?.provider === 'codex';
        void deliverPromptSequenceToSession({
          sessionId: params.sessionId,
          text: contextText,
          ptyManager: params.ptyManager,
          sessionManager: params.sessionManager,
          configLoader: params.configLoader,
          ...(params.contextDeliveryContext ? { deliveryContext: params.contextDeliveryContext } : {}),
          verifyDelivery: {
            label: 'spawn initial prompt',
            background: true,
            ...(isCodex ? { requirePromptSubmit: true } : {}),
            onComplete: (result) => {
              const writeLog = result.status === 'confirmed' || result.status === 'retry_confirmed'
                ? logger.info
                : logger.warn;
              writeLog(`[ConfiguredSessionSpawn] Initial prompt verification ${result.status} for ${params.sessionId}: ${result.detail}`);
            },
          },
        });
      } else {
        void deliverText(params.sessionId, contextText);
      }
      logger.info(`[ConfiguredSessionSpawn] Context prompt delivered to ${params.sessionId} (${contextText.length} chars)`);
    });
  }

  if (params.onPromptComplete) callbacks.push(params.onPromptComplete);
  if (callbacks.length === 0) return undefined;
  return () => {
    for (const callback of callbacks) callback();
  };
}
