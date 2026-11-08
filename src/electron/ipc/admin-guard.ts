import type { UserProfileStore } from '../../config/user-profile-store.js';

export interface AdminGuard {
  isAdmin(profileId: string): boolean;
  requireAdmin(profileId?: string): void;
}

/** Shared main-process authorization policy for operations reserved to the admin profile. */
export class MainProcessAdminGuard implements AdminGuard {
  constructor(
    private readonly profiles: Pick<UserProfileStore, 'isAdmin' | 'getActiveProfileId'>,
    private readonly getCallerProfileId: () => string = () => profiles.getActiveProfileId(),
  ) {}

  isAdmin(profileId: string): boolean {
    return this.profiles.isAdmin(profileId);
  }

  requireAdmin(profileId: string = this.getCallerProfileId()): void {
    if (!this.isAdmin(profileId)) throw new Error('Admin only');
  }
}

let mainProcessGuard: MainProcessAdminGuard | undefined;

export function initializeMainProcessAdminGuard<T extends Pick<UserProfileStore, 'isAdmin' | 'getActiveProfileId'>>(profiles: T): T {
  mainProcessGuard = new MainProcessAdminGuard(profiles);
  return profiles;
}

export function getMainProcessAdminGuard(): MainProcessAdminGuard {
  if (!mainProcessGuard) throw new Error('Main-process admin guard is not initialized');
  return mainProcessGuard;
}
