import type { ProfileRuntime } from '../../session/profile-runtime.js';
import type { ProfileRuntimeRegistry } from '../../session/profile-runtime-registry.js';
import type { PtyManager } from '../../session/pty-manager.js';
import { HandoverDelivery, type HandoverDeliveryOptions, type HandoverLossReason } from '../../session/handover-delivery.js';
import type { NotificationManager } from '../../session/notification-manager.js';
import { OperatorTaskWatcher } from '../../session/operator-task-watcher.js';
import { deliverPromptSequenceToSession } from '../../session/sequence-delivery.js';

type ProfileOnePromptOptions = Partial<Omit<
  Parameters<typeof deliverPromptSequenceToSession>[0],
  'sessionId' | 'text' | 'ptyManager' | 'sessionManager' | 'configLoader'
>>;

export function createProfileOnePromptDelivery(runtime: ProfileRuntime, ptyManager: PtyManager) {
  if (runtime.userProfileId !== '1') throw new Error('Profile 1 prompt delivery requires profileOneRuntime');
  return (sessionId: string, text: string, options: ProfileOnePromptOptions = {}) =>
    deliverPromptSequenceToSession({
      ...options,
      sessionId,
      text,
      ptyManager,
      sessionManager: runtime.sessionManager,
      configLoader: runtime.configLoader,
    });
}

export function createProfileOneHandoverDelivery(
  runtime: ProfileRuntime,
  ptyManager: PtyManager,
  notificationManager: NotificationManager,
  options: HandoverDeliveryOptions = {},
  verifyDelayMs = 4000,
): HandoverDelivery {
  if (runtime.userProfileId !== '1') throw new Error('Profile 1 handovers require profileOneRuntime');
  const deliverPrompt = createProfileOnePromptDelivery(runtime, ptyManager);
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

export function createProfileOneOperatorTaskWatcher(runtime: ProfileRuntime): OperatorTaskWatcher {
  if (runtime.userProfileId !== '1') throw new Error('Operator task checks require profileOneRuntime');
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
