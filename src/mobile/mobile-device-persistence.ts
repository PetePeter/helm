/**
 * mobile-device-persistence — the ONE place that reads/writes the paired-phone
 * registry (mobile-devices.yaml), the mobile pairing secrets
 * (mobile-secrets.yaml) and the chat journal (mobile-chat-journal.json).
 *
 * The split mirrors the fleet exactly: the registry is non-secret and holds only
 * `pskRef` references, while the PSK VALUES live base64 in mobile-secrets.yaml at
 * mode 0600 and NOWHERE else — never logged, never echoed to the renderer.
 *
 * All files resolve under the per-user app-data config dir (invariant 4); the
 * repo working tree is never written.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import { atomicWriteFileSync, isRecord } from '../session/persistence-utils.js';
import {
  MOBILE_DEVICES_FILE,
  MOBILE_SECRETS_FILE,
  MOBILE_CHAT_JOURNAL_FILE,
} from '../session/persistence-paths.js';
import type { MobileDevice } from '../types/mobile-device.js';
import type { ChatJournalState } from './mobile-chat-journal.js';
import { sanitizeMobileDevices } from './mobile-device-sanitize.js';

// ---- registry (YAML { devices: [...] }) -------------------------------------

export function saveMobileDevices(devices: MobileDevice[]): void {
  try {
    atomicWriteFileSync(MOBILE_DEVICES_FILE, YAML.stringify({ devices }));
  } catch (err) {
    logger.error(`[mobile-persist] Failed to save mobile devices: ${(err as Error).message}`);
  }
}

export function loadMobileDevices(): MobileDevice[] {
  try {
    if (!existsSync(MOBILE_DEVICES_FILE)) return [];
    const parsed = YAML.parse(readFileSync(MOBILE_DEVICES_FILE, 'utf8')) as unknown;
    if (!isRecord(parsed)) return [];
    return sanitizeMobileDevices(parsed.devices);
  } catch (err) {
    logger.error(`[mobile-persist] Failed to load mobile devices: ${(err as Error).message}`);
    return [];
  }
}

// ---- secrets ({ pskRef: base64 }) -------------------------------------------
// PSK VALUES are stored base64 here and NOWHERE else. Never logged.

export function saveMobileSecrets(secrets: Record<string, string>): void {
  try {
    atomicWriteFileSync(MOBILE_SECRETS_FILE, YAML.stringify(secrets), { mode: 0o600 });
  } catch (err) {
    logger.error(`[mobile-persist] Failed to save mobile secrets: ${(err as Error).message}`);
  }
}

export function loadMobileSecrets(): Record<string, string> {
  try {
    if (!existsSync(MOBILE_SECRETS_FILE)) return {};
    const parsed = YAML.parse(readFileSync(MOBILE_SECRETS_FILE, 'utf8')) as unknown;
    return isRecord(parsed) ? (parsed as Record<string, string>) : {};
  } catch (err) {
    logger.error(`[mobile-persist] Failed to load mobile secrets: ${(err as Error).message}`);
    return {};
  }
}

// ---- chat journal ({ nextSeq, entries: [...] }) ------------------------------
// Entries hold full chat texts, so this is the most personal file here. It lives
// under the same per-user app-data dir as everything else and nowhere else.

export function saveMobileChatJournal(state: ChatJournalState): void {
  try {
    atomicWriteFileSync(MOBILE_CHAT_JOURNAL_FILE, JSON.stringify(state));
  } catch (err) {
    logger.error(`[mobile-persist] Failed to save the chat journal: ${(err as Error).message}`);
  }
}

export function loadMobileChatJournal(): ChatJournalState | undefined {
  try {
    if (!existsSync(MOBILE_CHAT_JOURNAL_FILE)) return undefined;
    const parsed = JSON.parse(readFileSync(MOBILE_CHAT_JOURNAL_FILE, 'utf8')) as unknown;
    // Shape is the journal's hydrate's business; only "is it an object" is ours.
    return isRecord(parsed) ? (parsed as unknown as ChatJournalState) : undefined;
  } catch (err) {
    logger.error(`[mobile-persist] Failed to load the chat journal: ${(err as Error).message}`);
    return undefined;
  }
}
