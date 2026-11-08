import type { ProfileRuntime } from '../session/profile-runtime.js';
import type { AuthContext } from './tools/types.js';
import { HelmControlService } from './helm-control-service.js';
import type { LoopDriver } from '../session/hooks/loop-driver.js';
import type { ProfileMcpRouter } from './profile-mcp-router.js';
import type { ProfileRuntimeComposition } from '../electron/profile-runtime-composition.js';
import type { PtyManager } from '../session/pty-manager.js';
import type { NotificationManager } from '../session/notification-manager.js';
import type { ChatBroker } from '../session/chat/chat-broker.js';
import type { ReminderDeliveryFn } from '../session/reminder-delivery.js';
import { RemoteService, type RemoteServiceDeps } from '../session/remote/remote-service.js';
import type { PeerLinkManager } from './peer/peer-link-manager.js';
import { MobileArtifactUploadService } from '../mobile/mobile-artifact-upload.js';
import { MobileShareInbox } from '../mobile/mobile-share-inbox.js';
import { MobileChatBridge } from '../mobile/mobile-chat-bridge.js';
import { RingRetry } from '../session/ring-retry.js';
import { join } from 'node:path';

export interface ProfileMcpServiceSet {
  service: HelmControlService;
  uploads?: MobileArtifactUploadService;
  loopDriver?: Pick<LoopDriver, 'noteCompletion'>;
  dispose?: () => void;
  setPeerLinkManager?: (manager: PeerLinkManager | null) => void;
  remoteService?: RemoteService;
}

export interface ProfileRuntimeMcpOptions {
  composition: ProfileRuntimeComposition;
  ptyManager: PtyManager;
  notificationManager: NotificationManager;
  chatBroker: ChatBroker;
  messageFlightSink: (flight: import('../session/message-flight.js').SessionMessageFlight) => Promise<void> | void;
  apiContextSizeLookup: (sessionId: string) => import('../session/context-size.js').ApiSessionContextSize;
  reminderDelivery: ReminderDeliveryFn;
  tempDir: string;
  remoteServiceForRuntime: (runtime: ProfileRuntime) => RemoteService;
  currentPeerLinkManager: () => PeerLinkManager | null;
}

/** Build the shared fleet-owner service for profile 1 and viewer-only services for other profiles. */
export function createProfileRemoteService(
  runtime: ProfileRuntime,
  deps: Omit<RemoteServiceDeps, 'sessions' | 'fleetOwnerEnabled'>,
): RemoteService {
  return new RemoteService({
    ...deps,
    sessions: runtime.sessionManager,
    fleetOwnerEnabled: runtime.userProfileId === '1',
  });
}

/** Build the session/data plane for one profile, sharing only process services. */
export function createProfileRuntimeMcpServiceSet(
  runtime: ProfileRuntime,
  options: ProfileRuntimeMcpOptions,
): ProfileMcpServiceSet {
  const service = new HelmControlService(
    runtime.planManager,
    runtime.sessionManager,
    options.ptyManager,
    runtime.configLoader,
    runtime.planAttachmentManager,
    runtime.contextManager,
    runtime.scheduledTaskManager,
    runtime.projectStore,
    runtime.skillManager,
    runtime.skillAnalyticsManager,
  );
  service.setRestartAllowed(runtime.userProfileId === '1');
  service.sessionChangeFeed.attach(runtime.sessionManager);
  service.setNotificationManager(options.notificationManager);
  service.setChatBroker(options.chatBroker);
  service.setMessageFlightSink(options.messageFlightSink);
  service.setRuntimeGroupManager(runtime.runtimeGroupManager);
  service.setEtaTracker(runtime.etaTracker);
  service.setArtifactManager(runtime.artifactManager, runtime.artifactAttachmentManager);
  service.setDraftManager(runtime.draftManager);
  service.setTodoManager(runtime.todoManager);
  service.setMemoryManager(runtime.memoryManager, runtime.memoryAttachmentManager, runtime.artifactTempRegistry);
  service.setMessManager(runtime.messManager);
  service.setApiContextSizeLookup(options.apiContextSizeLookup);
  service.setReminderDelivery(options.reminderDelivery);
  service.setCompactSnapshot(sessionId =>
    options.composition.hookTrackers.get(runtime.userProfileId)?.snapshot(sessionId, 'quick compact'));
  const handover = options.composition.handoverDeliveries.get(runtime.userProfileId);
  if (handover) service.setHandoverDelivery(handover);

  const uploads = new MobileArtifactUploadService({
    attachments: runtime.artifactAttachmentManager,
    shares: new MobileShareInbox(join(options.tempDir, 'inbox', `profile-${runtime.userProfileId}`)),
  });
  service.setArtifactUploadService(uploads);

  const remoteService = options.remoteServiceForRuntime(runtime);
  const initialLinks = options.currentPeerLinkManager();
  remoteService.setLinks(initialLinks);
  service.setRemoteService(remoteService);
  service.setPeerLinkManager(initialLinks);

  return {
    service,
    uploads,
    remoteService,
    loopDriver: options.composition.loopDrivers.get(runtime.userProfileId),
    setPeerLinkManager: manager => {
      service.setPeerLinkManager(manager);
      remoteService.setLinks(manager);
    },
  };
}

/** Attach the shared mobile chat surface to each profile's session service. */
export function bindProfileMcpServicesToMobile(
  serviceSets: readonly ProfileMcpServiceSet[],
  bridge: MobileChatBridge,
): void {
  for (const set of serviceSets) {
    const { service } = set;
    service.setArtifactAttachmentDeletedHandler((sessionId, artifactId, attachmentId) =>
      bridge.deleteAttachmentMessages(sessionId, artifactId, attachmentId));
    service.setPhoneRinger((sessionId, reason) => bridge.sendRing(sessionId, reason));
    service.setCallTransferrer((fromSessionId, toSessionId, line) =>
      bridge.sendTransfer(fromSessionId, toSessionId, line));
    const retry = new RingRetry({
      ring: (sessionId, reason) => bridge.sendRing(sessionId, reason),
      missedOnce: (sessionId, reason, retryAt) => {
        const at = new Date(retryAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        bridge.sendAlert(sessionId, 'attention', `Missed call: ${reason}. I'll call back ~${at}`);
      },
      missedTwice: (sessionId, reason) => {
        const text = `Missed call again: ${reason}. No more retries, read me here`;
        if (!bridge.sendAlert(sessionId, 'attention', text)) {
          service.notifyUser(sessionId, 'Missed call from Helm', reason);
        }
      },
    });
    service.setRingRetry(retry);
    const previousDispose = set.dispose;
    set.dispose = () => {
      retry.dispose();
      previousDispose?.();
    };
  }
}

/** One cached MCP service set per runtime, disposed with the runtime composition. */
export class ProfileMcpServiceFactory {
  private readonly services = new Map<string, ProfileMcpServiceSet>();

  constructor(
    private readonly router: ProfileMcpRouter,
    profileOne: ProfileMcpServiceSet,
    private readonly build: (runtime: ProfileRuntime) => ProfileMcpServiceSet,
  ) {
    this.services.set('1', profileOne);
  }

  forCaller(authContext: AuthContext): ProfileMcpServiceSet {
    return this.forRuntime(this.router.runtimeForCaller(authContext));
  }

  forProfile(profileId: string): ProfileMcpServiceSet {
    return this.forRuntime(this.router.runtimeForProfile(profileId));
  }

  forRuntime(runtime: ProfileRuntime): ProfileMcpServiceSet {
    const cached = this.services.get(runtime.userProfileId);
    if (cached) return cached;
    const created = this.build(runtime);
    created.service.setRestartAllowed(runtime.userProfileId === '1');
    this.services.set(runtime.userProfileId, created);
    return created;
  }

  all(): ProfileMcpServiceSet[] {
    return [...this.services.values()];
  }

  sessionFeeds(): Iterable<import('../session/session-change-feed.js').SessionChangeFeed> {
    return [...this.services.values()].map(({ service }) => service.sessionChangeFeed);
  }

  setPeerLinkManager(manager: PeerLinkManager | null): void {
    for (const set of this.services.values()) set.setPeerLinkManager?.(manager);
  }

  dispose(): void {
    for (const set of this.services.values()) {
      set.dispose?.();
      set.service.dispose();
      set.remoteService?.dispose();
    }
    this.services.clear();
  }
}
