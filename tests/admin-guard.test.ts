import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { UserProfileStore } from '../src/config/user-profile-store.js';
import { MainProcessAdminGuard } from '../src/electron/ipc/admin-guard.js';

let root: string;
let profiles: UserProfileStore;
let guard: MainProcessAdminGuard;
let adminId: string;
let memberId: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-admin-guard-'));
  profiles = new UserProfileStore(root);
  profiles.ensureDefaultProfile();
  adminId = profiles.create('Administrator').id;
  memberId = profiles.create('Member').id;
  profiles.adminProfileId = adminId;
  guard = new MainProcessAdminGuard(profiles);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('main-process admin guard', () => {
  it.each([
    ['configured admin profile', () => adminId, true],
    ['default profile after reassignment', () => '1', false],
    ['ordinary member', () => memberId, false],
  ])('%s follows the assigned admin role', (_role, profileId, expected) => {
    expect(guard.isAdmin(profileId())).toBe(expected);
    if (expected) expect(() => guard.requireAdmin(profileId())).not.toThrow();
    else expect(() => guard.requireAdmin(profileId())).toThrow('Admin only');
  });

  it('uses the active profile when no explicit profile is supplied', () => {
    profiles.setActiveProfileId(adminId);
    expect(() => guard.requireAdmin()).not.toThrow();
    profiles.setActiveProfileId(memberId);
    expect(() => guard.requireAdmin()).toThrow('Admin only');
  });
});
