import { randomUUID } from 'crypto';
import { resolveEnvWithMode, type ConfigLoader, type ResolvedCliType } from '../config/loader.js';
import { mintSessionAuthToken } from '../mcp/session-auth.js';
import type { SessionManager } from './manager.js';
import { BUILTIN_SHELL_CLI_TYPE, type SessionInfo } from '../types/session.js';
import type { PtyManager, PtyProcess } from './pty-manager.js';
import type { DeliveryContext } from './delivery-context.js';
import { logger } from '../utils/logger.js';
import { toHeaderSafeName } from '../utils/header-safe-name.js';
import { normalizeProjectPath } from './project-identity.js';
import { getApiSessionHost } from './api/api-session-host.js';
import { getComfyUiSessionHost } from './comfyui/comfyui-session-host.js';
import { assertCwdInProfileProjects, getDefaultProfileProjectCwd } from './profile-spawn-cwd.js';
import { scheduleSessionReloadPrompt } from './session-reload-prompt.js';

export { resolveInitialPromptConfig } from './session-reload-prompt.js';

/** Nominal size for an adopted API session; it renders line output, so size is cosmetic. */
const API_SESSION_SIZE = { cols: 120, rows: 30 };

export interface SessionSpawnPreparation {
  /** Context fields needed by SessionStart, committed with the successor row. */
  sessionContext?: Pick<SessionInfo, 'mission' | 'currentPlanId'>;
  /** Reverse external context seeding if the process cannot be created. */
  rollback?: () => void;
}

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
  /** The CLI's own thread id for `{cliThreadId}`, when the caller holds it and the
   *  session record does not (a recycle-bin restore). Defaults to the session's. */
  resumeThreadId?: string;
  contextText?: string;
  /** Leave out the CLI type's configured initial prompt (rename still runs) — an unattended run must not inherit interactive house rules. */
  skipInitialPrompt?: boolean;
  /** Delivery context for contextText; background keeps a scheduled run out of the foreground. */
  contextDeliveryContext?: DeliveryContext;
  onPromptComplete?: () => void;
  onPromptCancel?: (cancel: () => void) => void;
  fallbackCompleteDelayMs?: number;
  markRestored?: (sessionId: string) => void;
  /** Remote Fleet peer that requested this spawn, when it came in over the peer proxy. */
  createdByPeerId?: string;
  /** Paired phone that requested this spawn, when it came in over the mobile proxy. */
  createdByMobileDeviceId?: string;
  /** Local or proxy creator for startup-prompt reporting; transient and never persisted. */
  creatorSessionId?: string;
  /** Born with its role/lock so no listener ever sees it as a plain session (the operator). */
  role?: SessionInfo['role'];
  locked?: boolean;
  /** Seed session-scoped reload context before its first CLI hook can run. */
  prepareSession?: (sessionId: string) => SessionSpawnPreparation | undefined;
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
  const profileRuntime = params.sessionManager.getSpawnCwdContext?.();
  const cwd = params.cwd ?? getDefaultProfileProjectCwd(profileRuntime ?? {});
  assertCwdInProfileProjects(profileRuntime ?? {}, cwd);
  const now = Date.now();
  const sessionId = params.sessionId ?? randomUUID();
  // Resolve once, up front: the session records the canonical uuid, never the
  // slug or display name the caller happened to use.
  const isShellSession = params.cliType === BUILTIN_SHELL_CLI_TYPE;
  const resolved = isShellSession ? undefined : resolveCliType(params.configLoader, params.cliType);
  const cliType = isShellSession ? BUILTIN_SHELL_CLI_TYPE : resolved?.id ?? params.cliType ?? 'unknown';
  const cfg = resolved?.config;
  // Falling back to the raw ref would name sessions after a UUID, so prefer the
  // human label whenever the type resolved.
  const sessionName = isShellSession
    ? 'Shell'
    : params.sessionName?.trim()
      || cfg?.displayName
      || cfg?.name
      || params.cliType
      || 'unknown';
  const isResume = Boolean(params.resumeSessionName);
  const cliSessionName = params.resumeSessionName || randomUUID();
  const cliThreadId = isResume
    ? params.resumeThreadId ?? params.sessionManager.getSession(sessionId)?.cliThreadId
    : undefined;
  const normalizedCwd = normalizeProjectPath(cwd);
  if (cfg?.api && cfg?.comfyUi) throw new Error('A tool type cannot be both API and ComfyUI');

  // An API tool has no CLI: Helm hosts the agent loop and adopts it like a Remote row.
  const apiProcess = cfg?.api
    ? getApiSessionHost().create({
      sessionId, userProfileId: params.sessionManager.getUserProfileId(), sessionName, cliSessionName, cliType, cwd: normalizedCwd, api: cfg.api,
      // The type's own env entries (with ${VAR} substitution) are where its API key lives.
      env: resolveConfiguredSpawnEnv(params.configLoader, params.cliType),
    })
    : null;
  const comfyUiProcess = cfg?.comfyUi
    ? getComfyUiSessionHost().create(sessionId, cfg.comfyUi, params.sessionManager.getUserProfileId())
    : null;
  // Copy context before creating a process: the new CLI may call SessionStart
  // as soon as its PTY is live, and artifacts are read by the hook by session id.
  const preparation = params.prepareSession?.(sessionId);
  let startNotified = false;
  let launched: { pty: PtyProcess; rawCommand?: string; command?: string; args?: string[] } | undefined;
  let removeRegisteredSessionOnFailure = false;
  try {
    if (comfyUiProcess) {
      params.ptyManager.adopt(sessionId, comfyUiProcess, API_SESSION_SIZE);
      launched = { pty: comfyUiProcess };
    } else if (apiProcess) {
      params.ptyManager.adopt(sessionId, apiProcess, API_SESSION_SIZE);
      launched = { pty: apiProcess };
    } else if (isShellSession && !params.command) {
      launched = { pty: params.ptyManager.spawn({ sessionId, cwd: normalizedCwd }) };
    } else {
      params.sessionManager.notifySessionStarting?.({
        sessionId,
        cliType,
        ...(params.creatorSessionId ? { creatorSessionId: params.creatorSessionId } : {}),
      });
      startNotified = true;
      launched = spawnCliProcess(params, { cfg, sessionId, sessionName, cliSessionName, cliThreadId, isResume, cwd: normalizedCwd });
    }
    const { pty } = launched;
    const sessionInfo = {
      id: sessionId,
      name: sessionName,
      cliType,
      processId: pty.pid,
      ...(normalizedCwd ? { workingDir: normalizedCwd } : {}),
      cliSessionName,
      ...(cliThreadId ? { cliThreadId } : {}),
      lastOutputAt: now,
      ...(params.createdByPeerId ? { createdByPeerId: params.createdByPeerId } : {}),
      ...(params.createdByMobileDeviceId ? { createdByMobileDeviceId: params.createdByMobileDeviceId } : {}),
      ...(params.role ? { role: params.role } : {}),
      ...(params.locked ? { locked: true } : {}),
      ...(preparation?.sessionContext ?? {}),
      ...(apiProcess ? { apiTool: true } : {}),
      ...(comfyUiProcess ? {
        comfyUiTool: true,
        comfyUiProfiles: comfyUiProcess.profiles,
        comfyUiImageSizes: comfyUiProcess.imageSizes,
      } : {}),
      ...(apiProcess && getApiSessionHost().parentOf(sessionId) ? { subagentOf: getApiSessionHost().parentOf(sessionId) } : {}),
    };

    if (isResume && params.sessionManager.hasSession(sessionId)) {
      params.sessionManager.updateSession(sessionId, sessionInfo);
    } else {
      // addSession may throw after storing the row (for example, an event
      // listener can fail), so remember whether this spawn owns a partial row.
      removeRegisteredSessionOnFailure = !params.sessionManager.hasSession(sessionId);
      params.sessionManager.addSession(sessionInfo);
    }
    // The API host starts only after registration so its first frame has a row.
    apiProcess?.start();
  } catch (error) {
    if (startNotified) {
      try { params.sessionManager.notifySessionSpawnFailed?.(sessionId); }
      catch (notifyError) { logger.error(`[ConfiguredSessionSpawn] Could not release startup observers for ${sessionId}: ${notifyError}`); }
    }
    if (launched) {
      try { params.ptyManager.kill(sessionId); }
      catch (killError) { logger.error(`[ConfiguredSessionSpawn] Could not stop failed session ${sessionId}: ${killError}`); }
    }
    try {
      if (removeRegisteredSessionOnFailure && params.sessionManager.hasSession(sessionId)) {
        params.sessionManager.removeSession(sessionId, { force: true });
      }
    } catch (removeError) {
      logger.error(`[ConfiguredSessionSpawn] Could not remove failed session ${sessionId}: ${removeError}`);
    }
    rollbackSessionPreparation(preparation, sessionId);
    throw error;
  }
  const { pty, rawCommand, command, args } = launched;

  scheduleSessionReloadPrompt({
    ...params,
    sessionId,
    cliSessionName,
    isResume,
    cfg,
  });

  return { sessionId, cliSessionName, pty, rawCommand, command, args };
}

function rollbackSessionPreparation(preparation: SessionSpawnPreparation | undefined, sessionId: string): void {
  try { preparation?.rollback?.(); }
  catch (error) { logger.error(`[ConfiguredSessionSpawn] Context rollback failed for ${sessionId}: ${error}`); }
}

/** Resolve the CLI command line and env, then spawn it in a real PTY. */
function spawnCliProcess(
  params: ConfiguredSessionSpawnParams,
  ctx: {
    cfg: ReturnType<ConfigLoader['getCliTypeEntry']> | undefined;
    sessionId: string;
    sessionName: string;
    cliSessionName: string;
    cliThreadId?: string;
    isResume: boolean;
    cwd?: string;
  },
): { pty: PtyProcess; rawCommand?: string; command?: string; args?: string[] } {
  let { rawCommand, command, args } = resolveSpawnCommand({
    cfg: ctx.cfg,
    cliType: params.cliType ?? 'unknown',
    cliSessionName: ctx.cliSessionName,
    cliThreadId: ctx.cliThreadId,
    isResume: ctx.isResume,
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
    sessionId: ctx.sessionId,
    sessionName: ctx.sessionName,
  });
  const pty = params.ptyManager.spawn({
    sessionId: ctx.sessionId,
    command,
    args,
    rawCommand,
    cwd: ctx.cwd,
    ...(env ? { env } : {}),
  });
  return { pty, rawCommand, command, args };
}

function resolveSpawnCommand(options: {
  cfg: ReturnType<ConfigLoader['getCliTypeEntry']> | undefined;
  cliType: string;
  cliSessionName: string;
  cliThreadId?: string;
  isResume: boolean;
  fallbackCommand?: string;
  fallbackArgs?: string[];
}): { rawCommand?: string; command?: string; args?: string[] } {
  if (options.isResume) {
    if (options.cfg?.resumeCommand) {
      // {cliThreadId} follows the CLI when /clear or /compact moves it to a new
      // id; before any hook reports one, the spawn-time name is still current.
      const rawCommand = options.cfg.resumeCommand
        .replaceAll('{cliSessionName}', options.cliSessionName)
        .replaceAll('{cliThreadId}', options.cliThreadId ?? options.cliSessionName);
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
  if (template === resolved && !template.includes('{cliThreadId}')) {
    logger.warn(`[ConfiguredSessionSpawn] ${field} has no {cliSessionName}/{cliThreadId} placeholder: ${template}`);
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
    // The CLI hook shim reads this (and the token above) from its inherited
    // environment — correlation for hooks needs no other plumbing.
    env.HELM_HOOK_URL = `http://127.0.0.1:${mcpPort}/hooks`;
    // Claude's configured statusline uses the same session token to report
    // live context usage without adding another Claude hook event.
    env.HELM_CONTEXT_USAGE_URL = `http://127.0.0.1:${mcpPort}/context-usage`;
  }
  return Object.keys(env).length > 0 ? env : undefined;
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
