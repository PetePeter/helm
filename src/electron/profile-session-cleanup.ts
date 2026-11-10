import type { ProfileRuntimeComposition } from './profile-runtime-composition.js';
import type { ProfileRuntime } from '../session/profile-runtime.js';
import type { SessionRemovedEvent } from '../types/session.js';
import { recordRemovedSession } from '../session/recycle-bin-manager.js';
import { logger } from '../utils/logger.js';

export interface ProfileSessionCleanupEffects {
  /** Forget process-level state keyed by this session id. */
  forgetSessionState?: (runtime: ProfileRuntime, sessionId: string) => void;
  /** Close a process-wide ComfyUI session while its owning runtime is known. */
  closeComfyUiSession?: (sessionId: string) => void;
  /** Drop a failed ComfyUI restore without deleting its saved images. */
  abortComfyUiSession?: (sessionId: string) => void;
  /** Prune the shared journal once any profile's session is permanently gone. */
  pruneMobileJournal?: (sessionId: string) => void;
}

/** Attach one owner-bound teardown path to every profile runtime. */
export function registerProfileSessionCleanup(
  composition: ProfileRuntimeComposition,
  effects: ProfileSessionCleanupEffects = {},
): void {
  composition.registerSessionRemovedHandler((runtime, event) => {
    cleanupRemovedProfileSession(runtime, event, effects);
  });
}

/** Apply teardown using only the runtime that emitted the session removal. */
export function cleanupRemovedProfileSession(
  runtime: ProfileRuntime,
  event: SessionRemovedEvent,
  effects: ProfileSessionCleanupEffects = {},
): void {
  const { sessionId } = event;
  effects.forgetSessionState?.(runtime, sessionId);

  if (event.reason === 'restore-rollback') {
    try {
      if (event.session?.comfyUiTool === true) effects.abortComfyUiSession?.(sessionId);
    } catch (error) {
      logger.error(`[IPC] Failed to abort ComfyUI restore ${sessionId}: ${error}`);
    }
    runtime.runtimeGroupManager.removeSessionEverywhere(sessionId);
    return;
  }

  if (event.session?.comfyUiTool === true) {
    try {
      effects.closeComfyUiSession?.(sessionId);
    } catch (error) {
      logger.error(`[IPC] Failed to clean ComfyUI images for closed session ${sessionId}: ${error}`);
    }
  }

  const runtimeGroup = runtime.runtimeGroupManager.groupForSession(sessionId);
  const projectRecord =
    (event.session?.projectId ? runtime.projectStore.getById(event.session.projectId) : undefined) ??
    (event.session?.workingDir ? runtime.projectStore.findByPath(event.session.workingDir) : undefined);
  const binned = recordRemovedSession(
    event,
    runtime.recycleBinManager,
    dir => runtime.configLoader.addBookmarkedDir(dir),
    runtimeGroup ? { id: runtimeGroup.id, name: runtimeGroup.name } : undefined,
    projectRecord ? { id: projectRecord.id, name: projectRecord.name } : undefined,
  );
  runtime.runtimeGroupManager.removeSessionEverywhere(sessionId);
  try {
    runtime.messManager.onSessionClosed(sessionId, binned ? 'recoverable' : 'ephemeral');
  } catch (error) {
    logger.error(`[IPC] Failed to update the Mess cursor for removed session ${sessionId}: ${error}`);
  }

  if (binned) return;
  try {
    runtime.memoryManager.purgeSession(sessionId);
  } catch (error) {
    logger.error(`[IPC] Failed to purge memories for removed session ${sessionId}: ${error}`);
  }
  try {
    runtime.artifactManager.clearSession(sessionId);
  } catch (error) {
    logger.error(`[IPC] Failed to clear artifacts for removed session ${sessionId}: ${error}`);
  }
  try {
    runtime.draftManager.clearSession(sessionId);
  } catch (error) {
    logger.error(`[IPC] Failed to clear the draft for removed session ${sessionId}: ${error}`);
  }
  try {
    runtime.todoManager.clearSession(sessionId);
  } catch (error) {
    logger.error(`[IPC] Failed to clear todos for removed session ${sessionId}: ${error}`);
  }
  try {
    effects.pruneMobileJournal?.(sessionId);
  } catch (error) {
    logger.error(`[IPC] Failed to prune the chat journal for removed session ${sessionId}: ${error}`);
  }
}
