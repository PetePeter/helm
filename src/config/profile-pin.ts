import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEY_LENGTH = 64;
const SALT_BYTES = 16;
const SCRYPT = { N: 1 << 14, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const HASH_PATTERN = /^scrypt\$([\da-f]{32})\$([\da-f]{128})$/i;

/** Hash a PIN with a fresh per-profile salt. The source PIN is never retained. */
export function hashProfilePin(pin: string): string {
  validatePin(pin);
  const salt = randomBytes(SALT_BYTES);
  const key = scryptSync(pin, salt, KEY_LENGTH, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export function isProfilePinHash(value: string): boolean {
  return HASH_PATTERN.test(value);
}

export function verifyProfilePin(pin: string, encodedHash: string): boolean {
  if (typeof pin !== 'string' || pin.length === 0 || pin.length > 128) return false;
  const match = HASH_PATTERN.exec(encodedHash);
  if (!match) return false;
  const expected = Buffer.from(match[2], 'hex');
  const actual = scryptSync(pin, Buffer.from(match[1], 'hex'), KEY_LENGTH, SCRYPT);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function validatePin(pin: string): void {
  if (typeof pin !== 'string' || pin.length === 0 || pin.length > 128) {
    throw new Error('PIN must be 1 to 128 characters');
  }
}

export interface ProfilePinRateLimiterOptions {
  now?: () => number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/** In-memory per-profile exponential backoff for failed PIN checks. */
export class ProfilePinRateLimiter {
  private readonly failures = new Map<string, { count: number; blockedUntil: number }>();
  private readonly now: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(options: ProfilePinRateLimiterOptions = {}) {
    this.now = options.now ?? Date.now;
    this.baseDelayMs = Math.max(1, options.baseDelayMs ?? 250);
    this.maxDelayMs = Math.max(this.baseDelayMs, options.maxDelayMs ?? 8_000);
  }

  retryAfterMs(profileId: string): number {
    return Math.max(0, (this.failures.get(profileId)?.blockedUntil ?? 0) - this.now());
  }

  recordFailure(profileId: string): number {
    const previous = this.failures.get(profileId);
    const count = (previous?.count ?? 0) + 1;
    const delay = Math.min(this.maxDelayMs, this.baseDelayMs * 2 ** (count - 1));
    this.failures.set(profileId, { count, blockedUntil: this.now() + delay });
    return delay;
  }

  recordSuccess(profileId: string): void {
    this.failures.delete(profileId);
  }
}
