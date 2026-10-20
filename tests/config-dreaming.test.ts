/**
 * ConfigLoader dreaming section: the one dream prompt every project's dream
 * runs with. The shipped default is stored as "no override" so later default
 * revisions still reach users who never edited it.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { ConfigLoader } from '../src/config/loader.js';
import { DEFAULT_DREAM_PROMPT } from '../src/types/dreaming.js';
import * as fs from 'fs';
import * as path from 'path';
import * as YAML from 'yaml';
import { makeTempRoot } from './helpers/temp-root.js';

let root: string | undefined;

function writeYaml(relativePath: string, data: unknown): void {
  const fullPath = path.join(root!, relativePath);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, YAML.stringify(data), 'utf8');
}

function makeLoader(settings: Record<string, unknown> = {}): ConfigLoader {
  root ??= makeTempRoot('helm-dreaming-');
  writeYaml('cli-types.yaml', {});
  writeYaml('bindings.yaml', {});
  writeYaml('settings.yaml', { ...settings });
  writeYaml('input-config.yaml', {});
  const loader = new ConfigLoader(root);
  loader.load();
  return loader;
}

function storedDreaming(): unknown {
  return (YAML.parse(fs.readFileSync(path.join(root!, 'settings.yaml'), 'utf8')) as Record<string, unknown>).dreaming;
}

afterEach(() => {
  if (root) fs.rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('ConfigLoader dreaming prompt', () => {
  it('falls back to the shipped prompt when absent or malformed', () => {
    expect(makeLoader().getDreamingConfig().prompt).toBe(DEFAULT_DREAM_PROMPT);
    root = undefined;
    expect(makeLoader({ dreaming: { prompt: 42 } }).getDreamingConfig().prompt).toBe(DEFAULT_DREAM_PROMPT);
  });

  it('stores an edited prompt and it survives a reload', () => {
    makeLoader().setDreamingConfig({ prompt: '  Prune hard.  ' });
    const reloaded = new ConfigLoader(root!);
    reloaded.load();
    expect(reloaded.getDreamingConfig().prompt).toBe('Prune hard.');
  });

  it('stores the default or an empty prompt as no override', () => {
    const loader = makeLoader({ dreaming: { prompt: 'Old edit' } });
    loader.setDreamingConfig({ prompt: DEFAULT_DREAM_PROMPT });
    expect(storedDreaming()).toEqual({ prompt: '' });
    loader.setDreamingConfig({ prompt: '   ' });
    expect(loader.getDreamingConfig().prompt).toBe(DEFAULT_DREAM_PROMPT);
  });
});
