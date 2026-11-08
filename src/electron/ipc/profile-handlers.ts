import { ipcMain } from 'electron';
import { dirname, resolve } from 'node:path';
import { rmSync } from 'node:fs';
import { ProfilePinRateLimiter, hashProfilePin, verifyProfilePin } from '../../config/profile-pin.js';
import type { UserProfileRecord, UserProfileStore } from '../../config/user-profile-store.js';
import type { MobileDeviceStore } from '../../mobile/mobile-device-store.js';
import { getProfileConfigDir } from '../../utils/app-paths.js';
import { ActiveProfileRuntimeView } from '../active-profile-runtime.js';
import type { ProfileRuntimeComposition } from '../profile-runtime-composition.js';
import type { WindowManager } from '../window-manager.js';
import { SuggestedPlanService } from '../../session/suggested-plan-service.js';
import type { IncomingPlansWatcher } from '../../session/incoming-plans-watcher.js';
import { ProfileMcpServiceFactory, bindProfileMcpServicesToMobile, type ProfileMcpServiceSet } from '../../mcp/profile-mcp-service-factory.js';
import type { ProfileMcpRouter } from '../../mcp/profile-mcp-router.js';
import type { MobileChatBridge } from '../../mobile/mobile-chat-bridge.js';
import type { ProfileRuntime } from '../../session/profile-runtime.js';

export interface ProfileSummary {
  id: string;
  name: string;
  hasPin: boolean;
  isActive: boolean;
  sessionCount: number;
  recoverableSessionCount: number;
  deviceCount: number;
  canDelete: boolean;
}

export type ProfileActionResult = { ok: true } | { ok: false; error: string; pinRequired?: boolean; retryAfterMs?: number };

export interface ProfileIpcControllerOptions {
  profileStore: UserProfileStore;
  composition: ProfileRuntimeComposition;
  runtimeView: ActiveProfileRuntimeView;
  devices: MobileDeviceStore;
  windowManager: WindowManager;
  onProfileChanged?: (id: string) => void | Promise<void>;
  onProfileAdded?: (id: string) => void;
  onProfileRemoved?: (id: string) => void;
}

/** Owns profile CRUD, PIN verification, and the desktop's active runtime selection. */
export class ProfileIpcController {
  private readonly rateLimiter = new ProfilePinRateLimiter();

  constructor(private readonly options: ProfileIpcControllerOptions) {}

  listProfiles(): ProfileSummary[] {
    const activeId = this.options.profileStore.getActiveProfileId();
    const devices = this.options.devices.list();
    return this.options.profileStore.list().map(profile => this.summary(profile, activeId, devices));
  }

  getActiveProfile(): ProfileSummary {
    const activeId = this.options.profileStore.getActiveProfileId();
    const profile = this.options.profileStore.list().find(item => item.id === activeId);
    if (!profile) throw new Error(`Active user profile does not exist: ${activeId}`);
    return this.summary(profile, activeId, this.options.devices.list());
  }

  createProfile(name: string): ProfileSummary {
    const profile = this.options.composition.createProfile(name);
    try {
      this.options.onProfileAdded?.(profile.id);
    } catch (error) {
      this.options.composition.removeProfileRuntime(profile.id);
      this.options.onProfileRemoved?.(profile.id);
      this.options.profileStore.remove(profile.id);
      throw error;
    }
    this.notify('profile:registryChanged');
    return this.summary(profile, this.options.profileStore.getActiveProfileId(), this.options.devices.list());
  }

  renameProfile(id: string, name: string): ProfileActionResult {
    try {
      this.options.profileStore.rename(id, name);
      this.notify('profile:registryChanged');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  setProfilePin(id: string, pin: string | null): ProfileActionResult {
    if (id !== this.options.profileStore.getActiveProfileId()) {
      return { ok: false, error: 'Switch to this profile before changing its PIN' };
    }
    if (pin !== null && !/^\d{4,12}$/.test(pin)) {
      return { ok: false, error: 'PIN must be 4 to 12 digits' };
    }
    try {
      this.options.profileStore.setPinHash(id, pin === null ? null : hashProfilePin(pin));
      this.rateLimiter.recordSuccess(id);
      this.notify('profile:registryChanged');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  async switchProfile(id: string, pin?: string): Promise<ProfileActionResult> {
    const profile = this.options.profileStore.list().find(item => item.id === id);
    if (!profile) return { ok: false, error: `Unknown user profile: ${id}` };
    if (id === this.options.profileStore.getActiveProfileId()) return { ok: true };

    const retryAfterMs = this.rateLimiter.retryAfterMs(id);
    if (retryAfterMs > 0) return { ok: false, error: 'Wait before trying this PIN again', retryAfterMs };
    if (profile.pinHash) {
      if (!pin) return { ok: false, error: 'PIN required', pinRequired: true };
      if (!verifyProfilePin(pin, profile.pinHash)) {
        return { ok: false, error: 'Incorrect PIN', retryAfterMs: this.rateLimiter.recordFailure(id) };
      }
    }

    const previousId = this.options.profileStore.getActiveProfileId();
    try {
      await this.options.onProfileChanged?.(id);
      this.options.profileStore.setActiveProfileId(id);
      this.options.runtimeView.select(this.options.composition.getRequiredRuntime(id));
      this.rateLimiter.recordSuccess(id);
      this.notify('profile:changed', this.getActiveProfile());
      return { ok: true };
    } catch (error) {
      try {
        this.options.profileStore.setActiveProfileId(previousId);
        this.options.runtimeView.select(this.options.composition.getRequiredRuntime(previousId));
        await this.options.onProfileChanged?.(previousId);
      } catch { /* Preserve the original switch error; the caller can retry. */ }
      return { ok: false, error: errorText(error) };
    }
  }

  bindDeviceToProfile(deviceId: string, userProfileId: string): ProfileActionResult {
    if (!this.options.profileStore.list().some(profile => profile.id === userProfileId)) {
      return { ok: false, error: `Unknown user profile: ${userProfileId}` };
    }
    if (!this.options.devices.update(deviceId, { userProfileId })) return { ok: false, error: 'Device not found' };
    this.notify('profile:registryChanged');
    return { ok: true };
  }

  deleteProfile(id: string): ProfileActionResult {
    if (id === '1') return { ok: false, error: 'The default profile cannot be deleted' };
    if (id === this.options.profileStore.getActiveProfileId()) {
      return { ok: false, error: 'Switch to another profile before deleting this one' };
    }
    if (this.options.devices.list().some(device => device.userProfileId === id)) {
      return { ok: false, error: 'Move paired devices to another profile before deleting this one' };
    }

    try {
      const runtime = this.options.composition.getRequiredRuntime(id);
      const appDataBase = dirname(dirname(dirname(this.options.profileStore.filePath)));
      const expectedDir = resolve(getProfileConfigDir(id, appDataBase));
      if (resolve(runtime.configDir) !== expectedDir) throw new Error('Profile directory failed validation');
      this.options.composition.removeProfileRuntime(id);
      this.options.onProfileRemoved?.(id);
      this.options.profileStore.remove(id);
      rmSync(expectedDir, { recursive: true, force: true });
      this.notify('profile:registryChanged');
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorText(error) };
    }
  }

  private summary(profile: UserProfileRecord, activeId: string, devices: ReturnType<MobileDeviceStore['list']>): ProfileSummary {
    const runtime = this.options.composition.getRequiredRuntime(profile.id);
    const sessionCount = runtime.sessionManager.getAllSessions().length;
    const recoverableSessionCount = runtime.recycleBinManager.list().length;
    const deviceCount = devices.filter(device => device.userProfileId === profile.id).length;
    return {
      id: profile.id,
      name: profile.name,
      hasPin: Boolean(profile.pinHash),
      isActive: profile.id === activeId,
      sessionCount,
      recoverableSessionCount,
      deviceCount,
      canDelete: profile.id !== '1' && profile.id !== activeId && sessionCount === 0 && recoverableSessionCount === 0 && deviceCount === 0,
    };
  }

  private notify(channel: 'profile:changed' | 'profile:registryChanged', payload?: ProfileSummary): void {
    const window = this.options.windowManager.getMainWindow();
    if (window && !window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

export function registerProfileIpcHandlers(controller: ProfileIpcController): () => void {
  const channels = [
    'profile:list', 'profile:active', 'profile:create', 'profile:rename', 'profile:setPin',
    'profile:switch', 'profile:delete', 'profile:bindDevice',
  ];
  ipcMain.handle('profile:list', () => controller.listProfiles());
  ipcMain.handle('profile:active', () => controller.getActiveProfile());
  ipcMain.handle('profile:create', (_event, name: string) => controller.createProfile(name));
  ipcMain.handle('profile:rename', (_event, id: string, name: string) => controller.renameProfile(id, name));
  ipcMain.handle('profile:setPin', (_event, id: string, pin: string | null) => controller.setProfilePin(id, pin));
  ipcMain.handle('profile:switch', (_event, id: string, pin?: string) => controller.switchProfile(id, pin));
  ipcMain.handle('profile:delete', (_event, id: string) => controller.deleteProfile(id));
  ipcMain.handle('profile:bindDevice', (_event, deviceId: string, profileId: string) => controller.bindDeviceToProfile(deviceId, profileId));
  return () => { for (const channel of channels) ipcMain.removeHandler(channel); };
}

export function setupProfileRuntimeIpcHandlers(options: Omit<ProfileIpcControllerOptions, 'onProfileAdded' | 'onProfileChanged' | 'onProfileRemoved'> & {
  profileMcpServiceFactory: ProfileMcpServiceFactory;
  incomingWatcher: IncomingPlansWatcher;
}): () => void {
  return registerProfileIpcHandlers(new ProfileIpcController({
    profileStore: options.profileStore,
    composition: options.composition,
    runtimeView: options.runtimeView,
    devices: options.devices,
    windowManager: options.windowManager,
    onProfileAdded: id => options.profileMcpServiceFactory.forProfile(id),
    onProfileChanged: async id => {
      const runtime = options.composition.getRequiredRuntime(id);
      options.profileMcpServiceFactory.forProfile(id);
      await options.incomingWatcher.switchTo(
        runtime.planManager,
        new SuggestedPlanService(runtime.planManager, runtime.memoryManager),
        runtime.configDir,
      );
    },
    onProfileRemoved: id => options.profileMcpServiceFactory.removeProfile(id),
  }));
}

export function setupProfileRuntimeDomain(options: Omit<ProfileIpcControllerOptions, 'onProfileAdded' | 'onProfileChanged' | 'onProfileRemoved'> & {
  incomingWatcher: IncomingPlansWatcher;
  router: ProfileMcpRouter;
  baseServices: ProfileMcpServiceSet;
  createServices: (runtime: ProfileRuntime) => ProfileMcpServiceSet;
}): {
  serviceFactory: ProfileMcpServiceFactory;
  cleanup: () => void;
  bindMobileChatBridge: (bridge: MobileChatBridge) => void;
} {
  let mobileChatBridge: MobileChatBridge | null = null;
  const serviceFactory = new ProfileMcpServiceFactory(options.router, options.baseServices, runtime => {
    const services = options.createServices(runtime);
    if (mobileChatBridge) bindProfileMcpServicesToMobile([services], mobileChatBridge);
    return services;
  });
  for (const runtime of options.composition.registry.all()) serviceFactory.forRuntime(runtime);
  const cleanup = setupProfileRuntimeIpcHandlers({
    profileStore: options.profileStore,
    composition: options.composition,
    runtimeView: options.runtimeView,
    devices: options.devices,
    windowManager: options.windowManager,
    profileMcpServiceFactory: serviceFactory,
    incomingWatcher: options.incomingWatcher,
  });
  return {
    serviceFactory,
    cleanup,
    bindMobileChatBridge: bridge => {
      mobileChatBridge = bridge;
      bindProfileMcpServicesToMobile(serviceFactory.all(), bridge);
    },
  };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
