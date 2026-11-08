import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { atomicWriteFileSync } from '../session/persistence-utils.js';
import { getGlobalPersistencePaths } from '../session/persistence-paths.js';
import { isProfilePinHash } from './profile-pin.js';

export interface UserProfileRecord {
  id: string;
  name: string;
  pinHash: string | null;
}

interface UserProfileDocument {
  version: 1;
  activeProfileId?: string;
  adminProfileId?: string;
  profiles: UserProfileRecord[];
}

const DEFAULT_PROFILE: UserProfileRecord = { id: '1', name: 'me', pinHash: null };

/** Global registry for user profiles. Raw PINs are never accepted or persisted. */
export class UserProfileStore {
  readonly filePath: string;

  constructor(private readonly globalConfigDir: string) {
    this.filePath = getGlobalPersistencePaths(globalConfigDir).userProfilesFile;
  }

  get adminProfileId(): string {
    return this.loadDocument().adminProfileId ?? DEFAULT_PROFILE.id;
  }

  set adminProfileId(id: string) {
    const document = this.loadDocument();
    if (!document.profiles.some(profile => profile.id === id)) throw new Error(`Unknown admin profile: ${id}`);
    this.save({ ...document, adminProfileId: id });
  }

  list(): UserProfileRecord[] {
    return this.loadDocument().profiles.map(profile => ({ ...profile }));
  }

  isAdmin(profileId: string): boolean {
    return profileId === this.adminProfileId;
  }

  getActiveProfileId(): string {
    const document = this.loadDocument();
    return document.profiles.some(profile => profile.id === document.activeProfileId)
      ? document.activeProfileId!
      : DEFAULT_PROFILE.id;
  }

  setActiveProfileId(id: string): void {
    const document = this.loadDocument();
    if (!document.profiles.some(profile => profile.id === id)) throw new Error(`Unknown user profile: ${id}`);
    this.save({ ...document, activeProfileId: id });
  }

  create(name: string): UserProfileRecord {
    this.ensureDefaultProfile();
    const document = this.loadDocument();
    const normalizedName = validateName(name);
    if (document.profiles.some(profile => profile.name.toLowerCase() === normalizedName.toLowerCase())) {
      throw new Error(`A user profile named "${normalizedName}" already exists`);
    }
    const profile = { id: randomUUID(), name: normalizedName, pinHash: null };
    this.save({ ...document, profiles: [...document.profiles, profile] });
    return { ...profile };
  }

  rename(id: string, name: string): void {
    const document = this.loadDocument();
    const normalizedName = validateName(name);
    if (!document.profiles.some(profile => profile.id === id)) throw new Error(`Unknown user profile: ${id}`);
    if (document.profiles.some(profile => profile.id !== id && profile.name.toLowerCase() === normalizedName.toLowerCase())) {
      throw new Error(`A user profile named "${normalizedName}" already exists`);
    }
    this.save({ ...document, profiles: document.profiles.map(profile => profile.id === id ? { ...profile, name: normalizedName } : profile) });
  }

  setPinHash(id: string, pinHash: string | null): void {
    const document = this.loadDocument();
    if (!document.profiles.some(profile => profile.id === id)) throw new Error(`Unknown user profile: ${id}`);
    if (pinHash !== null && !isProfilePinHash(pinHash)) throw new Error('Only a supported PIN hash may be stored');
    this.save({ ...document, profiles: document.profiles.map(profile => profile.id === id ? { ...profile, pinHash } : profile) });
  }

  remove(id: string): void {
    const document = this.loadDocument();
    if (id === DEFAULT_PROFILE.id) throw new Error('The default profile cannot be deleted');
    if (id === document.adminProfileId) throw new Error('The admin profile cannot be deleted');
    if (document.activeProfileId === id) throw new Error('Switch away from the active profile before deleting it');
    if (!document.profiles.some(profile => profile.id === id)) throw new Error(`Unknown user profile: ${id}`);
    this.save({ ...document, profiles: document.profiles.filter(profile => profile.id !== id) });
  }

  ensureDefaultProfile(): void {
    const document = this.loadDocument();
    const profiles = document.profiles.some(profile => profile.id === DEFAULT_PROFILE.id)
      ? document.profiles
      : [DEFAULT_PROFILE, ...document.profiles];
    const activeProfileId = profiles.some(profile => profile.id === document.activeProfileId)
      ? document.activeProfileId!
      : DEFAULT_PROFILE.id;
    const adminProfileId = profiles.some(profile => profile.id === document.adminProfileId)
      ? document.adminProfileId!
      : DEFAULT_PROFILE.id;
    if (profiles === document.profiles
      && document.activeProfileId === activeProfileId
      && document.adminProfileId === adminProfileId) return;
    this.save({ version: 1, activeProfileId, adminProfileId, profiles });
  }

  private loadDocument(): UserProfileDocument {
    if (!existsSync(this.filePath)) return { version: 1, adminProfileId: DEFAULT_PROFILE.id, profiles: [] };
    const parsed = YAML.parse(readFileSync(this.filePath, 'utf8')) as unknown;
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.profiles)) {
      throw new Error(`Invalid user profile registry: ${this.filePath}`);
    }

    const seen = new Set<string>();
    const profiles = parsed.profiles.map((value): UserProfileRecord => {
      if (!isRecord(value)) throw new Error('Invalid user profile record');
      if ('pin' in value || 'pinCode' in value || 'rawPin' in value) {
        throw new Error('Raw PIN fields are not allowed in the user profile registry');
      }
      if (Object.keys(value).some(key => !['id', 'name', 'pinHash'].includes(key))) {
        throw new Error('Unknown field in user profile record');
      }
      if (typeof value.id !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value.id) || seen.has(value.id)) {
        throw new Error('User profile ids must be safe and unique');
      }
      if (typeof value.name !== 'string' || value.name.trim() === '') {
        throw new Error('User profile name must not be empty');
      }
      if (value.pinHash !== null && typeof value.pinHash !== 'string') {
        throw new Error('User profile pinHash must be a string or null');
      }
      if (value.pinHash !== null && !isProfilePinHash(value.pinHash)) {
        throw new Error('User profile pinHash is invalid');
      }
      seen.add(value.id);
      return { id: value.id, name: value.name, pinHash: value.pinHash };
    });

    if (parsed.activeProfileId !== undefined
      && (typeof parsed.activeProfileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(parsed.activeProfileId))) {
      throw new Error('Invalid active user profile id');
    }
    if (parsed.adminProfileId !== undefined
      && (typeof parsed.adminProfileId !== 'string' || !/^[A-Za-z0-9_-]+$/.test(parsed.adminProfileId))) {
      throw new Error('Invalid admin user profile id');
    }
    const adminProfileId = (parsed.adminProfileId as string | undefined) ?? DEFAULT_PROFILE.id;
    if (parsed.adminProfileId !== undefined && !profiles.some(profile => profile.id === adminProfileId)) {
      throw new Error(`Unknown admin profile: ${adminProfileId}`);
    }
    return {
      version: 1,
      activeProfileId: parsed.activeProfileId as string | undefined,
      adminProfileId,
      profiles,
    };
  }

  private save(document: UserProfileDocument): void {
    atomicWriteFileSync(this.filePath, YAML.stringify(document));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateName(name: string): string {
  const normalized = name.trim();
  if (!normalized || normalized.length > 48) throw new Error('User profile name must be 1 to 48 characters');
  return normalized;
}
