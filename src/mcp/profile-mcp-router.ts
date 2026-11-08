import type { MobileDeviceStore } from '../mobile/mobile-device-store.js';
import { deviceIdFromMobileSessionId, isMobileSessionId } from '../mobile/mobile-identity.js';
import type { ProfileRuntime } from '../session/profile-runtime.js';
import type { ProfileRuntimeComposition } from '../electron/profile-runtime-composition.js';
import { UserProfileStore } from '../config/user-profile-store.js';
import { isProxySessionId } from './peer/proxy-identity.js';
import type { AuthContext } from './tools/types.js';

/** Resolves an authenticated MCP caller to the runtime that owns its data. */
export class ProfileMcpRouter {
  private readonly userProfileStore: UserProfileStore;

  constructor(
    private readonly composition: ProfileRuntimeComposition,
    private readonly deviceStore: Pick<MobileDeviceStore, 'get'>,
  ) {
    const firstRuntime = composition.registry.all()[0];
    if (!firstRuntime) throw new Error('No profile runtime is available for MCP routing');
    this.userProfileStore = new UserProfileStore(firstRuntime.configLoader.getGlobalConfigDir());
  }

  runtimeForCaller(authContext: AuthContext): ProfileRuntime {
    const sessionId = authContext.sessionId;
    if (!sessionId) {
      const adminProfile = this.userProfileStore.list().find(profile => this.userProfileStore.isAdmin(profile.id));
      if (!adminProfile) throw new Error('Admin profile is not configured');
      return this.runtimeForProfile(adminProfile.id);
    }

    if (isMobileSessionId(sessionId)) {
      const deviceId = deviceIdFromMobileSessionId(sessionId);
      const device = deviceId ? this.deviceStore.get(deviceId) : undefined;
      const profileId = device?.userProfileId;
      if (!profileId) throw new Error(`Mobile caller has no profile binding: ${deviceId ?? 'unknown device'}`);
      return this.runtimeForProfile(profileId);
    }

    // Fleet calls are process-level capabilities. Their proxy identity must not
    // be mistaken for a local session or a mobile profile binding.
    if (isProxySessionId(sessionId)) return this.runtimeForProfile(this.userProfileStore.adminProfileId);

    const owner = this.composition.registry.findSessionOwner(sessionId);
    if (!owner) throw new Error(`Unknown session owner: ${sessionId}`);
    return owner;
  }

  runtimeForProfile(profileId: string): ProfileRuntime {
    return this.composition.getRequiredRuntime(profileId);
  }

  profileForSession(sessionId: string): string | undefined {
    const owners = this.composition.registry.all().filter(runtime =>
      runtime.sessionManager.hasSession(sessionId)
      || runtime.recycleBinManager.list().some(entry => entry.sessionId === sessionId));
    if (owners.length > 1) throw new Error(`Session id is owned by more than one profile: ${sessionId}`);
    return owners[0]?.userProfileId;
  }

  resolveSessionIdentity(sessionId: string): { id: string; name: string } | null {
    const owner = this.composition.registry.findSessionOwner(sessionId);
    const session = owner?.sessionManager.getSession(sessionId);
    return session ? { id: session.id, name: session.name } : null;
  }
}
