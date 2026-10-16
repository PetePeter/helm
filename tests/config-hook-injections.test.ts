import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { ConfigLoader } from '../src/config/loader.js';
import { HOOK_INJECTION_DEFINITIONS } from '../src/session/hooks/hook-injections.js';

const TEST_DIR = path.join(process.cwd(), '.test-hook-injections-' + Date.now());

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

describe('hook injection settings', () => {
  afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

  it('uses shipped defaults when no overrides are saved', () => {
    expect(makeLoader().getHookInjectionOverrides()).toEqual({});
    expect(HOOK_INJECTION_DEFINITIONS.length).toBeGreaterThan(0);
  });

  it('keeps only known string overrides within the size limit', () => {
    const loader = makeLoader({ hookInjections: {
      amberContextAlert: 'Custom {{tokens}}',
      unknownInjection: 'ignored',
      redContextAlert: 42,
      workingPlan: 'x'.repeat(10001),
    } });
    expect(loader.getHookInjectionOverrides()).toEqual({ amberContextAlert: 'Custom {{tokens}}' });
  });

  it('merges and persists partial edits, then reset removes all overrides', () => {
    const loader = makeLoader();
    loader.setHookInjectionOverrides({ amberContextAlert: 'Amber custom' });
    loader.setHookInjectionOverrides({ redContextAlert: 'Red custom' });
    expect(loader.getHookInjectionOverrides()).toEqual({
      amberContextAlert: 'Amber custom',
      redContextAlert: 'Red custom',
    });
    expect((readYaml<{ hookInjections: Record<string, string> }>('settings.yaml')).hookInjections)
      .toMatchObject({ amberContextAlert: 'Amber custom', redContextAlert: 'Red custom' });

    loader.setHookInjectionOverrides({ amberContextAlert: null });
    expect(loader.getHookInjectionOverrides()).toEqual({ redContextAlert: 'Red custom' });
    loader.resetHookInjectionOverrides();
    expect(loader.getHookInjectionOverrides()).toEqual({});
    expect((readYaml<Record<string, unknown>>('settings.yaml')).hookInjections).toBeUndefined();
  });
});
