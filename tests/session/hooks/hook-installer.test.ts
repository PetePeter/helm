/**
 * HookInstaller — system-wide CLI hook install, against a real filesystem.
 *
 * Every test runs in a throwaway temp dir standing in for the user's HOME, so
 * the reads and writes are real: what these tests prove about merging,
 * idempotency and reversibility is what the user's ~/.claude/settings.json
 * experiences. Only the interpreter probe is faked (injected runCommand) —
 * the shim itself has its own test.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  installCliHooks,
  probeInterpreter,
  readHookIntegrationStatus,
  uninstallCliHooks,
  type HookInstallerDeps,
} from '../../../src/session/hooks/hook-installer';
import type { CliHooksIntegration } from '../../../src/config/loader';

let home: string;
let shimPath: string;

const CLAUDE: CliHooksIntegration = {
  provider: 'claude',
  configPath: '~/.claude/settings.json',
  events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'],
};
const CODEX: CliHooksIntegration = {
  provider: 'codex',
  configPath: '~/.codex/hooks.json',
  events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PreCompact', 'Stop'],
};
const COPILOT: CliHooksIntegration = {
  provider: 'copilot',
  configPath: '~/.copilot/hooks/helm.json',
  events: ['sessionStart', 'userPromptSubmitted', 'preToolUse', 'postToolUse', 'preCompact', 'agentStop'],
};

/** Deps with an interpreter probe that always finds `python`. */
function depsWithPython(): HookInstallerDeps {
  return {
    homeDir: () => home,
    shimPath,
    runCommand: async (command) =>
      command === 'python' ? { code: 0 } : { code: 1 },
  };
}

/** Deps whose probe finds no interpreter at all. */
function depsWithoutPython(): HookInstallerDeps {
  return {
    homeDir: () => home,
    shimPath,
    runCommand: async () => ({ code: 127 }),
  };
}

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(home, rel), 'utf8'));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'helm-hooks-'));
  shimPath = join(home, 'AppData', 'Roaming', 'Helm', 'config', 'hooks', 'helm-hook-shim.py');
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('probeInterpreter', () => {
  it('returns the first candidate that actually runs', async () => {
    expect(await probeInterpreter(depsWithPython())).toEqual({ command: 'python', args: [] });
  });

  it('returns null when no candidate runs', async () => {
    expect(await probeInterpreter(depsWithoutPython())).toBeNull();
  });
});

describe('installCliHooks (Claude settings.json)', () => {
  it('writes nothing and reports interpreter-missing when the probe fails', async () => {
    const result = await installCliHooks(CLAUDE, depsWithoutPython());

    expect(result).toEqual({ status: 'interpreter-missing', written: false });
    expect(existsSync(join(home, '.claude', 'settings.json'))).toBe(false);
  });

  it('writes only the Helm block into a settings.json holding unrelated user keys, which survive verbatim', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { allow: ['Bash(npm test)'] }, model: 'opus' }),
    );

    const result = await installCliHooks(CLAUDE, depsWithPython());

    expect(result).toMatchObject({ status: 'installed', written: true });
    const settings = readJson('.claude/settings.json');
    expect(settings.permissions).toEqual({ allow: ['Bash(npm test)'] });
    expect(settings.model).toBe('opus');
    expect(Object.keys(settings.hooks)).toEqual(CLAUDE.events);
    const group = settings.hooks.PreToolUse[0];
    expect(group.matcher).toBe('*');
    expect(group.hooks[0].type).toBe('command');
    expect(group.hooks[0].command).toContain(`"${shimPath}" claude PreToolUse`);
    expect(group.hooks[0].command).toMatch(/^"python"/);
    expect(group.hooks[0].timeout).toBe(10);
  });

  it('creates the config file when it does not exist', async () => {
    await installCliHooks(CLAUDE, depsWithPython());
    expect(readJson('.claude/settings.json').hooks).toBeTruthy();
  });

  it('leaves user-owned hook entries on the same events untouched', async () => {
    const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'C:/tools/mine.sh' }] };
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [userGroup] } }));

    await installCliHooks(CLAUDE, depsWithPython());

    const groups = readJson('.claude/settings.json').hooks.PreToolUse;
    expect(groups).toHaveLength(2);
    expect(groups).toContainEqual(userGroup);
  });

  it('is idempotent: re-install on an already-current file is a no-op', async () => {
    await installCliHooks(CLAUDE, depsWithPython());
    const before = readFileSync(join(home, '.claude', 'settings.json'), 'utf8');

    const again = await installCliHooks(CLAUDE, depsWithPython());

    expect(again).toMatchObject({ status: 'installed', written: false });
    expect(readFileSync(join(home, '.claude', 'settings.json'), 'utf8')).toBe(before);
  });
});

describe('installCliHooks (Codex hooks.json / Copilot helm.json)', () => {
  it('writes the Codex matcher-group shape', async () => {
    await installCliHooks(CODEX, depsWithPython());

    const hooks = readJson('.codex/hooks.json');
    expect(Object.keys(hooks.hooks)).toEqual(CODEX.events);
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toContain(`"${shimPath}" codex PreToolUse`);
  });

  it('writes the Copilot flat-entry shape with version 1 into the Helm-owned file', async () => {
    await installCliHooks(COPILOT, depsWithPython());

    const file = readJson('.copilot/hooks/helm.json');
    expect(file.version).toBe(1);
    expect(Object.keys(file.hooks)).toEqual(COPILOT.events);
    const entry = file.hooks.agentStop[0];
    expect(entry.type).toBe('command');
    expect(entry.command).toContain(`"${shimPath}" copilot agentStop`);
    expect(entry.timeoutSec).toBe(10);
  });
});

describe('uninstallCliHooks', () => {
  it('removes only the Helm block; user keys and user hooks survive', async () => {
    const userGroup = { matcher: 'Bash', hooks: [{ type: 'command', command: 'C:/tools/mine.sh' }] };
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({ model: 'opus', hooks: { PreToolUse: [userGroup], Stop: [] } }),
    );
    await installCliHooks(CLAUDE, depsWithPython());

    const result = uninstallCliHooks(CLAUDE, depsWithPython());

    expect(result.changed).toBe(true);
    const settings = readJson('.claude/settings.json');
    expect(settings.model).toBe('opus');
    expect(settings.hooks.PreToolUse).toEqual([userGroup]);
    // The user's `Stop: []` carried no hooks, so the emptied key is dropped
    // with Helm's — an empty array holds nothing of the user's to preserve.
    expect(settings.hooks.Stop).toBeUndefined();
    expect(Object.keys(settings.hooks)).toEqual(['PreToolUse']);
  });

  it('is a no-op when nothing is installed', () => {
    expect(uninstallCliHooks(CLAUDE, depsWithPython()).changed).toBe(false);
  });

  it('deletes the Helm-owned Copilot file when it holds nothing else', async () => {
    await installCliHooks(COPILOT, depsWithPython());

    uninstallCliHooks(COPILOT, depsWithPython());

    expect(existsSync(join(home, '.copilot', 'hooks', 'helm.json'))).toBe(false);
  });

  it('keeps the Helm-owned Copilot file when the user added their own entries', async () => {
    await installCliHooks(COPILOT, depsWithPython());
    const path = join(home, '.copilot', 'hooks', 'helm.json');
    const file = readJson('.copilot/hooks/helm.json');
    file.hooks.sessionStart.push({ type: 'prompt', prompt: 'Review TODOs' });
    writeFileSync(path, JSON.stringify(file, null, 2));

    uninstallCliHooks(COPILOT, depsWithPython());

    const kept = readJson('.copilot/hooks/helm.json');
    expect(kept.hooks.sessionStart).toEqual([{ type: 'prompt', prompt: 'Review TODOs' }]);
  });
});

describe('readHookIntegrationStatus', () => {
  it('reports not-installed when no Helm block exists on disk', async () => {
    expect(await readHookIntegrationStatus(CLAUDE, depsWithPython())).toBe('not-installed');
  });

  it('reports interpreter-missing when the probe finds nothing, ahead of any file state', async () => {
    await installCliHooks(CLAUDE, depsWithPython());

    expect(await readHookIntegrationStatus(CLAUDE, depsWithoutPython())).toBe('interpreter-missing');
  });

  it('reports installed for a current install', async () => {
    await installCliHooks(CLAUDE, depsWithPython());
    expect(await readHookIntegrationStatus(CLAUDE, depsWithPython())).toBe('installed');
  });

  it('reports outdated when the on-disk command no longer matches the probed interpreter', async () => {
    await installCliHooks(CLAUDE, depsWithPython());

    const newShim: HookInstallerDeps = {
      homeDir: () => home,
      shimPath,
      runCommand: async (command) =>
        command === 'py' ? { code: 0 } : { code: 1 },
    };
    expect(await readHookIntegrationStatus(CLAUDE, newShim)).toBe('outdated');
  });

  it('reports outdated when an event is missing from the installed set', async () => {
    await installCliHooks(CLAUDE, depsWithPython());
    const path = join(home, '.claude', 'settings.json');
    const settings = readJson('.claude/settings.json');
    delete settings.hooks.PreCompact;
    writeFileSync(path, JSON.stringify(settings, null, 2));

    expect(await readHookIntegrationStatus(CLAUDE, depsWithPython())).toBe('outdated');
  });
});
