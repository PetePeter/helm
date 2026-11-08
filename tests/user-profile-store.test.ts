import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProfilePinRateLimiter, hashProfilePin, verifyProfilePin } from '../src/config/profile-pin.js';
import { UserProfileStore } from '../src/config/user-profile-store.js';

let root: string;
let store: UserProfileStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'helm-user-profiles-'));
  store = new UserProfileStore(root);
  store.ensureDefaultProfile();
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('UserProfileStore', () => {
  it('keeps profile 1 as the default and persists the active profile globally', () => {
    expect(store.getActiveProfileId()).toBe('1');
    const child = store.create('Child 1');
    store.setActiveProfileId(child.id);

    const reloaded = new UserProfileStore(root);
    expect(reloaded.getActiveProfileId()).toBe(child.id);
    expect(reloaded.list().map(profile => profile.name)).toEqual(['me', 'Child 1']);
  });

  it('renames profiles and stores only a hash when a PIN is set', () => {
    const profile = store.create('Child 1');
    const hash = hashProfilePin('2718');
    store.rename(profile.id, 'Ari');
    store.setPinHash(profile.id, hash);

    expect(store.list().find(item => item.id === profile.id)).toEqual({ id: profile.id, name: 'Ari', pinHash: hash });
    const document = readFileSync(store.filePath, 'utf8');
    expect(document).toContain(hash);
    expect(document).not.toContain('2718');
  });

  it('rejects selecting an unknown profile and deleting profile 1', () => {
    expect(() => store.setActiveProfileId('missing')).toThrow(/Unknown user profile/);
    expect(() => store.remove('1')).toThrow(/default profile/i);
  });
});

describe('profile PINs', () => {
  it('uses a per-PIN salt and verifies without accepting malformed hashes', () => {
    const first = hashProfilePin('2718');
    const second = hashProfilePin('2718');
    expect(first).not.toBe(second);
    expect(verifyProfilePin('2718', first)).toBe(true);
    expect(verifyProfilePin('0000', first)).toBe(false);
    expect(verifyProfilePin('2718', 'not-a-pin-hash')).toBe(false);
  });

  it('backs off repeated failures and clears the delay after a successful PIN', () => {
    let now = 10_000;
    const limiter = new ProfilePinRateLimiter({ now: () => now, baseDelayMs: 250, maxDelayMs: 4_000 });
    expect(limiter.retryAfterMs('child')).toBe(0);
    expect(limiter.recordFailure('child')).toBe(250);
    expect(limiter.retryAfterMs('child')).toBe(250);

    now += 250;
    expect(limiter.recordFailure('child')).toBe(500);
    now += 500;
    limiter.recordSuccess('child');
    expect(limiter.retryAfterMs('child')).toBe(0);
  });
});
