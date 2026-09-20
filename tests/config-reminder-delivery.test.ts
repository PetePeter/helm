/**
 * ConfigLoader reminderDelivery section (G9): absent means the shipped
 * defaults, malformed values are dropped (never crash, never misroute), and
 * setReminderDelivery round-trips through settings.yaml.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { DEFAULT_REMINDER_MODES, REMINDER_IDS } from '../src/session/reminder-delivery';

const TEST_DIR = path.join(process.cwd(), '.test-reminder-delivery-' + Date.now());

function writeYaml(relativePath: string, data: unknown): void {
  const fullPath = path.join(TEST_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, YAML.stringify(data), 'utf8');
}

function readYaml<T>(relativePath: string): T {
  return YAML.parse(fs.readFileSync(path.join(TEST_DIR, relativePath), 'utf8')) as T;
}

function makeLoader(settings: Record<string, unknown> = {}): ConfigLoader {
  writeYaml('cli-types.yaml', {});
  writeYaml('bindings.yaml', {});
  writeYaml('settings.yaml', { hapticFeedback: true, notifications: true, escProtectionEnabled: true, ...settings });
  writeYaml('input-config.yaml', {});
  const loader = new ConfigLoader(TEST_DIR);
  loader.load();
  return loader;
}

describe('reminderDelivery settings', () => {
  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('returns an empty override set when the section is absent', () => {
    const loader = makeLoader();
    expect(loader.getReminderDelivery()).toEqual({});
  });

  it('returns valid overrides and drops malformed values', () => {
    const loader = makeLoader({
      reminderDelivery: { helmMsgRules: 'pty', telegramInstruction: 'nonsense', telegramModeInstructions: 7 },
    });
    expect(loader.getReminderDelivery()).toEqual({ helmMsgRules: 'pty' });
  });

  it('drops unknown reminder ids entirely', () => {
    const loader = makeLoader({ reminderDelivery: { noSuchReminder: 'off' } });
    expect(loader.getReminderDelivery()).toEqual({});
  });

  it('degrades to empty when the section is not an object', () => {
    const loader = makeLoader({ reminderDelivery: 'hook' });
    expect(loader.getReminderDelivery()).toEqual({});
  });

  it('setReminderDelivery merges, persists and round-trips', () => {
    const loader = makeLoader();
    loader.setReminderDelivery({ helmMsgRules: 'off' });
    expect(loader.getReminderDelivery()).toEqual({ helmMsgRules: 'off' });

    loader.setReminderDelivery({ telegramModeInstructions: 'hook' });
    expect(loader.getReminderDelivery()).toEqual({ helmMsgRules: 'off', telegramModeInstructions: 'hook' });

    // Persisted: a fresh loader over the same dir reads the same overrides.
    const reloaded = makeLoader(readYaml<Record<string, unknown>>('settings.yaml'));
    expect(reloaded.getReminderDelivery()).toEqual({ helmMsgRules: 'off', telegramModeInstructions: 'hook' });
  });

  it('setReminderDelivery ignores invalid values rather than storing them', () => {
    const loader = makeLoader();
    loader.setReminderDelivery({ helmMsgRules: 'carrier-pigeon' as never, telegramInstruction: 'hook' });
    expect(loader.getReminderDelivery()).toEqual({ telegramInstruction: 'hook' });
  });

  it('the defaults cover exactly the shipped reminder ids', () => {
    expect(Object.keys(DEFAULT_REMINDER_MODES).sort()).toEqual([...REMINDER_IDS].sort());
  });
});
