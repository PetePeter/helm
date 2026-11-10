import type { ProfileRuntime } from '../../session/profile-runtime.js';
import type { ProfileRuntimeRegistry } from '../../session/profile-runtime-registry.js';
import type { PtyManager } from '../../session/pty-manager.js';
import type { StateDetector } from '../../session/state-detector.js';
import type { UserProfileStore } from '../../config/user-profile-store.js';
import type { MobileDeviceStore } from '../../mobile/mobile-device-store.js';
import type { ProfileMcpServiceFactory } from '../../mcp/profile-mcp-service-factory.js';
import { spawnConfiguredSession } from '../../session/configured-session-spawn.js';
import type { RecycleBinEntry, RecycleBinRestorer } from '../../types/recycle-bin.js';
import { logger } from '../../utils/logger.js';
import { HandoverDelivery, type HandoverDeliveryOptions, type HandoverLossReason } from '../../session/handover-delivery.js';
import type { NotificationManager } from '../../session/notification-manager.js';
import { OperatorTaskWatcher } from '../../session/operator-task-watcher.js';
import { deliverPromptSequenceToSession } from '../../session/sequence-delivery.js';
import { getMainProcessAdminGuard, type AdminGuard } from './admin-guard.js';
import { reattachRestoredSession } from '../../session/runtime-group-restore.js';

export function ringAnsweredForBoundDevice(options: {
  sessionId: string | undefined;
  deviceId: string | undefined;
  devices: MobileDeviceStore;
  profiles: UserProfileStore;
  registry: ProfileRuntimeRegistry;
  services: ProfileMcpServiceFactory;
}): boolean {
  const profileId = options.deviceId ? options.devices.get(options.deviceId)?.userProfileId : undefined;
  if (!profileId || !options.profiles.list().some(profile => profile.id === profileId)) return false;
  try {
    options.registry.getRequiredRuntime(profileId);
    options.services.forProfile(profileId).service.ringAnswered(options.sessionId);
    return true;
  } catch {
    return false;
  }
}

export function createProfileRecycleBinRestorer(options: {
  registry: ProfileRuntimeRegistry;
  getActiveProfileId: () => string;
  ptyManager: PtyManager;
  stateDetector: Pick<StateDetector, 'markRestored'>;
  trackPromptCanceller: (sessionId: string, cancel: () => void) => void;
  spawn?: typeof spawnConfiguredSession;
}): RecycleBinRestorer {
  const inFlight = new Set<string>();
  const spawn = options.spawn ?? spawnConfiguredSession;
  return async (entryId, request = {}) => {
    const profileId = request.profileId ?? options.getActiveProfileId();
    const key = JSON.stringify([profileId, entryId]);
    if (inFlight.has(key)) throw new Error('Recycle-bin restore is already in progress');
    inFlight.add(key);
    try {
      const runtime = options.registry.all().find(candidate => candidate.userProfileId === profileId);
      if (!runtime) throw new Error(`Profile runtime not found: ${profileId}`);
      const entry = runtime.recycleBinManager.peek(entryId);
      if (!entry) throw new Error(`Recycle-bin entry not found or expired: ${entryId}`);
      if (request.expectedName !== undefined && request.expectedName !== entry.name) {
        throw new Error('Expected name does not match the recycle-bin entry');
      }
      if (runtime.sessionManager.hasSession(entry.sessionId) || options.ptyManager.has(entry.sessionId)) {
        throw new Error(`Session is already running: ${entry.sessionId}`);
      }

      // spawnConfiguredSession enforces the cwd against this runtime's projects.
      runtime.configLoader.reloadActiveProfileIfChanged();
      // Keep the per-entry lock until spawn completes so concurrent MCP calls cannot duplicate it.
      await spawn({
        ptyManager: options.ptyManager,
        sessionManager: runtime.sessionManager,
        configLoader: runtime.configLoader,
        sessionId: entry.sessionId,
        cliType: entry.cliType,
        cwd: entry.workingDir,
        resumeSessionName: entry.cliSessionName,
        resumeThreadId: entry.cliThreadId,
        markRestored: sessionId => options.stateDetector.markRestored(sessionId),
        onPromptCancel: cancel => options.trackPromptCanceller(entry.sessionId, cancel),
      });
      try {
        runtime.sessionManager.restoreMission(entry.sessionId, entry.mission, entry.missionBarHeight);
      } catch (error) {
        logger.warn(`[recycleBin:restore] Failed to re-apply mission: ${error}`);
      }
      const name = entry.name?.trim();
      if (name && name !== entry.cliType) {
        try {
          runtime.sessionManager.renameSession(entry.sessionId, name);
        } catch (error) {
          logger.warn(`[recycleBin:restore] Failed to restore session name: ${error}`);
        }
      }
      try {
        reattachRestoredSession(runtime.runtimeGroupManager, entry, entry.sessionId);
      } catch (error) {
        logger.warn(`[recycleBin:restore] Failed to restore runtime group: ${error}`);
      }
      runtime.recycleBinManager.forget(entry.id);
      return entry;
    } catch (error) {
      logger.error(`[recycleBin:restore] Failed: ${error}`);
      throw error;
    } finally {
      inFlight.delete(key);
    }
  };
}

type AdminPromptOptions = Partial<Omit<
  Parameters<typeof deliverPromptSequenceToSession>[0],
  'sessionId' | 'text' | 'ptyManager' | 'sessionManager' | 'configLoader'
>>;

export function createAdminPromptDelivery(
  runtime: ProfileRuntime,
  ptyManager: PtyManager,
  adminGuard: AdminGuard = getMainProcessAdminGuard(),
) {
  adminGuard.requireAdmin(runtime.userProfileId);
  return (sessionId: string, text: string, options: AdminPromptOptions = {}) =>
    deliverPromptSequenceToSession({
      ...options,
      sessionId,
      text,
      ptyManager,
      sessionManager: runtime.sessionManager,
      configLoader: runtime.configLoader,
    });
}

export function createAdminHandoverDelivery(
  runtime: ProfileRuntime,
  ptyManager: PtyManager,
  notificationManager: NotificationManager,
  options: HandoverDeliveryOptions = {},
  verifyDelayMs = 4000,
  adminGuard: AdminGuard = getMainProcessAdminGuard(),
): HandoverDelivery {
  adminGuard.requireAdmin(runtime.userProfileId);
  const deliverPrompt = createAdminPromptDelivery(runtime, ptyManager, adminGuard);
  return new HandoverDelivery(
    ptyManager,
    runtime.sessionManager,
    async (sessionId, text) => {
      await deliverPrompt(sessionId, text, {
        verifyDelivery: { label: 'handover', delayMs: verifyDelayMs, retrySubmit: true },
      });
    },
    (sessionId, reason: HandoverLossReason) => {
      const name = runtime.sessionManager.getSession(sessionId)?.name ?? sessionId;
      notificationManager.notifyLlmDirected(
        sessionId,
        'Handover lost',
        reason === 'cancelled'
          ? `The pending handover for "${name}" was cancelled and will not be delivered.`
          : reason === 'session-closed'
            ? `"${name}" closed before its handover could be delivered.`
            : `The handover for "${name}" could not be written to its terminal.`,
      );
    },
    {
      ...options,
      nudge: options.nudge ?? (sessionId => { ptyManager.write(sessionId, '\x1b\x1b\x1b', 'system'); }),
    },
  );
}

export function createAdminOperatorTaskWatcher(
  runtime: ProfileRuntime,
  adminGuard: AdminGuard = getMainProcessAdminGuard(),
): OperatorTaskWatcher {
  adminGuard.requireAdmin(runtime.userProfileId);
  return new OperatorTaskWatcher({
    onSessionUpdated: listener => { runtime.sessionManager.on('session:updated', listener); },
    onSessionRemoved: listener => { runtime.sessionManager.on('session:removed', listener); },
    onTimerChanged: listener => { runtime.scheduledTaskManager.on('task:changed', listener); },
    getSession: id => runtime.sessionManager.getSession(id),
    getPlan: id => runtime.planManager.getItem(id),
    patchPlanTask: (id, patch) => { runtime.planManager.updateWithType(id, { task: patch }); },
    listScheduledTasks: () => runtime.scheduledTaskManager.listTasks(),
    runTaskNow: id => runtime.scheduledTaskManager.runTaskNow(id),
    deleteTask: id => runtime.scheduledTaskManager.deleteTask(id),
  });
}

interface DesktopChatService {
  sendDesktopChatTextToSession(sessionId: string, text: string): Promise<unknown>;
}

export async function sendDesktopChatToSessionOwner(options: {
  registry: ProfileRuntimeRegistry;
  serviceForProfile: (profileId: string) => DesktopChatService;
  sessionId: string;
  text: string;
}): Promise<void> {
  const owner = options.registry.findSessionOwner(options.sessionId);
  if (!owner) throw new Error(`Session not found: ${options.sessionId}`);
  await options.serviceForProfile(owner.userProfileId).sendDesktopChatTextToSession(options.sessionId, options.text);
}
