import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { atomicWriteFileSync } from '../session/persistence-utils.js';
import { getGlobalPersistencePaths } from '../session/persistence-paths.js';

export interface UserProfileRecord {
  id: string;
  name: string;
  pinHash: string | null;
}

interface UserProfileDocument {
  version: 1;
  profiles: UserProfileRecord[];
}

const DEFAULT_PROFILE: UserProfileRecord = { id: '1', name: 'me', pinHash: null };

/** Global registry for user profiles. Raw PINs are never accepted or persisted. */
export class UserProfileStore {
  readonly filePath: string;

  constructor(private readonly globalConfigDir: string) {
    this.filePath = getGlobalPersistencePaths(globalConfigDir).userProfilesFile;
  }

  list(): UserProfileRecord[] {
    return this.loadDocument().profiles.map(profile => ({ ...profile }));
  }

  ensureDefaultProfile(): void {
    const document = this.loadDocument();
    if (document.profiles.some(profile => profile.id === DEFAULT_PROFILE.id)) return;
    this.save({ version: 1, profiles: [DEFAULT_PROFILE, ...document.profiles] });
  }

  private loadDocument(): UserProfileDocument {
    if (!existsSync(this.filePath)) return { version: 1, profiles: [] };
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
      seen.add(value.id);
      return { id: value.id, name: value.name, pinHash: value.pinHash };
    });

    return { version: 1, profiles };
  }

  private save(document: UserProfileDocument): void {
    atomicWriteFileSync(this.filePath, YAML.stringify(document));
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
