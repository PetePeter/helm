/**
 * ConfigLoader hooks.loopDriving section (G8): absent means the shipped
 * defaults (feature allowed, cap 5), malformed values degrade to those
 * defaults — never crash, never silently uncap the loop.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { DEFAULT_MAX_AUTO_CONTINUES } from '../src/session/hooks/loop-driver';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';

const TEST_DIR = path.join(process.cwd(), '.test-loop-driving-' + Date.now());

function writeYaml(relativePath: string, data: unknown): void {
  const fullPath = path.join(TEST_DIR, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, YAML.stringify(data), 'utf8');
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

describe('hooks.loopDriving settings', () => {
  afterEach(() => {
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('defaults to enabled with the shipped cap when the section is absent', () => {
    const loader = makeLoader();
    expect(loader.getLoopDrivingConfig()).toEqual({ enabled: true, maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES });
  });

  it('reads an explicit kill switch and cap', () => {
    const loader = makeLoader({ hooks: { loopDriving: { enabled: false, maxAutoContinues: 2 } } });
    expect(loader.getLoopDrivingConfig()).toEqual({ enabled: false, maxAutoContinues: 2 });
  });

  it('degrades to defaults on malformed values — a junk cap never uncaps the loop', () => {
    const loader = makeLoader({ hooks: { loopDriving: { enabled: 'yes', maxAutoContinues: 'many' } } });
    expect(loader.getLoopDrivingConfig()).toEqual({ enabled: true, maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES });
  });

  it('rejects a non-positive cap rather than storing an unbounded loop', () => {
    const loader = makeLoader({ hooks: { loopDriving: { maxAutoContinues: 0 } } });
    expect(loader.getLoopDrivingConfig().maxAutoContinues).toBe(DEFAULT_MAX_AUTO_CONTINUES);
    const zeroNegative = makeLoader({ hooks: { loopDriving: { maxAutoContinues: -3 } } });
    expect(zeroNegative.getLoopDrivingConfig().maxAutoContinues).toBe(DEFAULT_MAX_AUTO_CONTINUES);
  });

  it('degrades when the section is not an object', () => {
    const loader = makeLoader({ hooks: { loopDriving: 'off' } });
    expect(loader.getLoopDrivingConfig()).toEqual({ enabled: true, maxAutoContinues: DEFAULT_MAX_AUTO_CONTINUES });
  });
});
