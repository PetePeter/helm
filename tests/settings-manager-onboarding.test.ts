import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SettingsManager } from '../src/config/settings-manager';

const tempDirs: string[] = [];

function managerWithSettings(contents: string): SettingsManager {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'helm-onboarding-settings-'));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, 'settings.yaml'), contents, 'utf8');
  return new SettingsManager(dir);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('first-run onboarding migration', () => {
  it('keeps a fresh-install default eligible for onboarding', () => {
    const manager = managerWithSettings('hapticFeedback: false\nnotifications: true\nonboardingCompleted: false\n');

    expect(manager.load().onboardingCompleted).toBe(false);
  });

  it('migrates an existing settings file to completed so upgrades do not interrupt users', () => {
    const manager = managerWithSettings('hapticFeedback: false\nnotifications: true\n');

    expect(manager.load().onboardingCompleted).toBe(true);
    expect(fs.readFileSync(path.join(tempDirs[0], 'settings.yaml'), 'utf8')).toContain('onboardingCompleted: true');
  });
});
