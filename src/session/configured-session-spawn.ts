import { randomUUID } from 'crypto';
import { resolveEnvWithMode, type ConfigLoader, type ResolvedCliType, type SequenceListItem } from '../config/loader.js';
import { mintSessionAuthToken } from '../mcp/session-auth.js';
import { parseSubmitSuffix } from '../mcp/submit-suffix.js';
import type { SessionManager } from './manager.js';
import { scheduleInitialPrompt } from './initial-prompt.js';
import type { PtyManager, PtyProcess } from './pty-manager.js';
import { deliverPromptSequenceToSession } from './sequence-delivery.js';
import type { DeliveryContext } from './delivery-context.js';
import { logger } from '../utils/logger.js';
import { toHeaderSafeName } from '../utils/header-safe-name.js';
import { normalizeProjectPath } from './project-identity.js';

/** Pause before writing the submit suffix so bracketed/paste-aware CLIs can settle. */
const SUBMIT_DELAY_MS = 200;

export interface ConfiguredSessionSpawnParams {
  ptyManager: PtyManager;
  sessionManager: SessionManager;
  configLoader?: ConfigLoader;
  sessionId?: string;
  cliType?: string;
  sessionName?: string;
  command?: string;
  args?: string[];
  /** Extra arguments appended to the resolved command, e.g. a scheduled task's cliParams. */
  extraArgs?: string;
  cwd?: string;
  resumeSessionName?: string;
  contextText?: string;
  /** Delivery context for contextText; background keeps a scheduled run out of the foreground. */
  contextDeliveryContext?: DeliveryContext;
  onPromptComplete?: () => void;
  onPromptCancel?: (cancel: () => void) => void;
  fallbackCompleteDelayMs?: number;
  markRestored?: (sessionId: string) => void;
  /** Remote Fleet peer that requested this spawn, when it came in over the peer proxy. */
  createdByPeerId?: string;
}

export interface ConfiguredSessionSpawnResult {
  sessionId: string;
  cliSessionName: string;
  pty: PtyProcess;
  rawCommand?: string;
  command?: string;
  args?: string[];
}

export function spawnConfiguredSession(params: ConfiguredSessionSpawnParams): ConfiguredSessionSpawnResult {
  const now = Date.now();
  const sessionId = params.sessionId ?? randomUUID();
  // Resolve once, up front: the session records the canonical uuid, never the
  // slug or display name the caller happened to use.
  const resolved = resolveCliType(params.configLoader, params.cliType);
  const cliType = resolved?.id ?? params.cliType ?? 'unknown';
  const cfg = resolved?.config;
  // Falling back to the raw ref would name sessions after a UUID, so prefer the
  // human label whenever the type resolved.
  const sessionName = params.sessionName?.trim()
    || cfg?.displayName
    || cfg?.name
    || params.cliType
    || 'unknown';
  const isResume = Boolean(params.resumeSessionName);
  const cliSessionName = params.resumeSessionName || randomUUID();
  let { rawCommand, command, args } = resolveSpawnCommand({
    cfg,
    cliType: params.cliType ?? 'unknown',
    cliSessionName,
    isResume,
    fallbackCommand: params.command,
    fallbackArgs: params.args,
  });
  // Appended after template resolution so extra args land at the end of the
  // command line regardless of which branch produced it.
  const extraArgs = params.extraArgs?.trim();
  if (extraArgs) {
    if (rawCommand) rawCommand = `${rawCommand} ${extraArgs}`;
    else args = [...(args ?? []), ...extraArgs.split(/\s+/)];
  }
  const env = resolveConfiguredSpawnEnv(params.configLoader, params.cliType, {
    sessionId,
    sessionName,
  });

  const normalizedCwd = params.cwd ? normalizeProjectPath(params.cwd) : undefined;

  const pty = params.ptyManager.spawn({
    sessionId,
    command,
    args,
    rawCommand,
    cwd: normalizedCwd,
    ...(env ? { env } : {}),
  });

  const sessionInfo = {
    id: sessionId,
    name: sessionName,
    cliType,
    processId: pty.pid,
    ...(normalizedCwd ? { workingDir: normalizedCwd } : {}),
    cliSessionName,
    lastOutputAt: now,
    ...(params.createdByPeerId ? { createdByPeerId: params.createdByPeerId } : {}),
  };

  if (isResume && params.sessionManager.hasSession(sessionId)) {
    params.sessionManager.updateSession(sessionId, sessionInfo);
  } else {
    params.sessionManager.addSession(sessionInfo);
  }

  scheduleConfiguredInitialPrompt({
    ...params,
    sessionId,
    cliSessionName,
    isResume,
    cfg,
  });

  return { sessionId, cliSessionName, pty, rawCommand, command, args };
}

function scheduleConfiguredInitialPrompt(params: ConfiguredSessionSpawnParams & {
  sessionId: string;
  cliSessionName: string;
  isResume: boolean;
  cfg: ReturnType<ConfigLoader['getCliTypeEntry']> | undefined;
}): void {
  const deliverText = (sessionId: string, text: string): Promise<void> => {
    const maybeDeliver = (params.ptyManager as Partial<PtyManager>).deliverText;
    if (typeof maybeDeliver === 'function') {
      return maybeDeliver.call(params.ptyManager, sessionId, text);
    }
    params.ptyManager.write(sessionId, text);
    return Promise.resolve();
  };
  const submit = async (sessionId: string): Promise<void> => {
    await new Promise<void>((resolve) => setTimeout(resolve, SUBMIT_DELAY_MS));
    const submitSuffix = parseSubmitSuffix(params.cfg?.submitSuffix);
    const maybeDeliver = (params.ptyManager as Partial<PtyManager>).deliverText;
    if (typeof maybeDeliver === 'function') {
      return maybeDeliver.call(params.ptyManager, sessionId, '', { submitSuffix });
    }
    params.ptyManager.write(sessionId, submitSuffix);
  };

  const promptConfig = resolveInitialPromptConfig(params.cfg, params.cliSessionName);
  if (params.isResume) {
    params.markRestored?.(params.sessionId);
    if (!promptConfig.renameCommand) return;
    const cancel = scheduleInitialPrompt(
      params.sessionId,
      {
        initialPromptDelay: promptConfig.initialPromptDelay,
        renameCommand: promptConfig.renameCommand,
      },
      (sid, data) => params.ptyManager.write(sid, data),
      (sid, text) => deliverText(sid, text),
      undefined,
      submit,
    );
    if (cancel) params.onPromptCancel?.(cancel);
    return;
  }

  const onComplete = buildPromptCompleteHandler(params, deliverText);
  const cancel = scheduleInitialPrompt(
    params.sessionId,
    promptConfig,
    (sid, data) => params.ptyManager.write(sid, data),
    (sid, text) => deliverText(sid, text),
    onComplete ?? (() => undefined),
    submit,
  );

  if (cancel) {
    params.onPromptCancel?.(cancel);
  } else if (onComplete) {
    const timeout = setTimeout(onComplete, params.fallbackCompleteDelayMs ?? 500);
    params.onPromptCancel?.(() => clearTimeout(timeout));
  }
}

function buildPromptCompleteHandler(
  params: ConfiguredSessionSpawnParams & { sessionId: string; sessionManager: SessionManager; ptyManager: PtyManager },
  deliverText: (sessionId: string, text: string) => Promise<void>,
): (() => void) | undefined {
  const contextText = typeof params.contextText === 'string' && params.contextText.length > 0
    ? params.contextText
    : undefined;
  const callbacks: Array<() => void> = [];

  if (contextText) {
    callbacks.push(() => {
      if (params.configLoader) {
        void deliverPromptSequenceToSession({
          sessionId: params.sessionId,
          text: contextText,
          ptyManager: params.ptyManager,
          sessionManager: params.sessionManager,
          configLoader: params.configLoader,
          ...(params.contextDeliveryContext ? { deliveryContext: params.contextDeliveryContext } : {}),
        });
      } else {
        void deliverText(params.sessionId, contextText);
      }
      logger.info(`[ConfiguredSessionSpawn] Context prompt delivered to ${params.sessionId} (${contextText.length} chars)`);
    });
  }

  if (params.onPromptComplete) {
    callbacks.push(params.onPromptComplete);
  }

  if (callbacks.length === 0) return undefined;
  return () => {
    for (const callback of callbacks) callback();
  };
}

function resolveSpawnCommand(options: {
  cfg: ReturnType<ConfigLoader['getCliTypeEntry']> | undefined;
  cliType: string;
  cliSessionName: string;
  isResume: boolean;
  fallbackCommand?: string;
  fallbackArgs?: string[];
}): { rawCommand?: string; command?: string; args?: string[] } {
  if (options.isResume) {
    if (options.cfg?.resumeCommand) {
      const rawCommand = options.cfg.resumeCommand.replaceAll('{cliSessionName}', options.cliSessionName);
      warnIfMissingPlaceholder('resumeCommand', options.cfg.resumeCommand, rawCommand);
      return { rawCommand };
    }
    if (options.cfg?.continueCommand) {
      return { rawCommand: options.cfg.continueCommand };
    }
  } else if (options.cfg?.spawnCommand) {
    const rawCommand = options.cfg.spawnCommand.replaceAll('{cliSessionName}', options.cliSessionName);
    warnIfMissingPlaceholder('spawnCommand', options.cfg.spawnCommand, rawCommand);
    return { rawCommand };
  }

  // No template on the CLI type and no explicit command from the caller. There
  // used to be a `command: cliType` fallback here; now that a cliType is a UUID
  // that would try to execute the identity string. Fail loudly instead.
  if (!options.fallbackCommand) {
    throw new Error(
      `Cannot spawn CLI type "${options.cliType}": it has no spawnCommand/resumeCommand/continueCommand configured and no explicit command was supplied.`,
    );
  }

  return {
    command: options.fallbackCommand,
    args: options.fallbackArgs ?? [],
  };
}

function warnIfMissingPlaceholder(field: string, template: string, resolved: string): void {
  if (template === resolved) {
    logger.warn(`[ConfiguredSessionSpawn] ${field} has no {cliSessionName} placeholder: ${template}`);
  }
}

export function resolveConfiguredSpawnEnv(
  configLoader: ConfigLoader | undefined,
  cliType: string | undefined,
  helmSession?: { sessionId: string; sessionName: string },
): Record<string, string> | undefined {
  const envEntries = resolveCliType(configLoader, cliType)?.config.env;
  const env = resolveEnvWithMode(envEntries ?? [], process.env as Record<string, string | undefined>, resolveEnvValue);
  if (helmSession) {
    const mcpConfig = configLoader?.getMcpConfig?.();
    const mcpPort = mcpConfig?.port ?? 47373;
    env.HELM_MCP_TOKEN = mintSessionAuthToken(
      mcpConfig?.authToken ?? '',
      helmSession.sessionId,
      helmSession.sessionName,
    );
    env.HELM_SESSION_ID = helmSession.sessionId;
    // MCP clients put this straight into a request header, so it must be
    // header-legal by construction — see toHeaderSafeName.
    env.HELM_SESSION_NAME = toHeaderSafeName(helmSession.sessionName);
    env.HELM_MCP_URL = `http://127.0.0.1:${mcpPort}/mcp`;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function resolveInitialPromptConfig(
  cliEntry: ReturnType<ConfigLoader['getCliTypeEntry']> | undefined,
  cliSessionName: string,
): { initialPrompt?: SequenceListItem[]; initialPromptDelay?: number; renameCommand?: string } {
  if (!cliEntry) return {};
  const renameCommand = cliEntry.renameCommand && cliSessionName
    ? cliEntry.renameCommand.replace('{cliSessionName}', cliSessionName)
    : undefined;
  return {
    initialPrompt: cliEntry.initialPrompt,
    initialPromptDelay: cliEntry.initialPromptDelay,
    renameCommand,
  };
}

/**
 * Resolve a caller-supplied CLI type ref through the ConfigLoader choke point.
 * Returns undefined when there is no loader or no match — callers then rely on
 * an explicitly supplied command, or fail in resolveSpawnCommand.
 */
function resolveCliType(configLoader: ConfigLoader | undefined, cliType: string | undefined): ResolvedCliType | undefined {
  if (!configLoader || !cliType) return undefined;
  return configLoader.resolveCliType?.(cliType) ?? undefined;
}

function resolveEnvValue(value: string): string {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => process.env[name] ?? '')
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (_match, name: string) => process.env[name] ?? '');
}
