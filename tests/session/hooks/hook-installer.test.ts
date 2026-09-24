/**
 * HookInstaller — system-wide CLI hook install, against a real filesystem.
 *
 * Every test runs in a throwaway temp dir standing in for the user's HOME, so
 * the reads and writes are real: what these tests prove about merging,
 * idempotency and reversibility is what the user's ~/.claude/settings.json
 * experiences. Only the interpreter probe is faked (injected runCommand) —
 * the shim itself has its own test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildHookSnippet,
  installCliHooks,
  probeInterpreter,
  readHookIntegrationStatus,
  uninstallCliHooks,
  type HookInstallerDeps,
} from '../../../src/session/hooks/hook-installer';
import type { CliHooksIntegration } from '../../../src/config/loader';
import { logger } from '../../../src/utils/logger.js';

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
    // Claude shells out, so the shim path is always quoted — robust against
    // any path the shell would otherwise split or reinterpret.
    expect(group.hooks[0].command).toBe(`python "${shimPath}" claude PreToolUse`);
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
    expect(hooks.hooks.PreToolUse[0].hooks[0].command).toBe(`python ${shimPath} codex PreToolUse`);
  });

  it('writes the Copilot flat-entry shape with version 1 into the Helm-owned file', async () => {
    await installCliHooks(COPILOT, depsWithPython());

    const file = readJson('.copilot/hooks/helm.json');
    expect(file.version).toBe(1);
    expect(Object.keys(file.hooks)).toEqual(COPILOT.events);
    const entry = file.hooks.agentStop[0];
    expect(entry.type).toBe('command');
    expect(entry.command).toBe(`python "${shimPath}" copilot agentStop`);
    expect(entry.timeoutSec).toBe(10);
  });
});

describe('hook command quoting', () => {
  it('always quotes the shim path for shell-run providers (claude, copilot), never for codex', async () => {
    expect(shimPath).not.toMatch(/\s/);
    await installCliHooks(CLAUDE, depsWithPython());
    await installCliHooks(COPILOT, depsWithPython());
    await installCliHooks(CODEX, depsWithPython());

    expect(readJson('.claude/settings.json').hooks.Stop[0].hooks[0].command).toContain(`"${shimPath}"`);
    expect(readJson('.copilot/hooks/helm.json').hooks.agentStop[0].command).toContain(`"${shimPath}"`);
    expect(readJson('.codex/hooks.json').hooks.Stop[0].hooks[0].command).not.toContain('"');
  });

  it('replaces an existing unquoted Helm entry with the quoted one instead of duplicating it', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true });
    writeFileSync(
      join(home, '.claude', 'settings.json'),
      JSON.stringify({
        hooks: {
          Stop: [{ matcher: '*', hooks: [{ type: 'command', command: `python ${shimPath} claude Stop`, timeout: 10 }] }],
        },
      }),
    );

    const result = await installCliHooks(CLAUDE, depsWithPython());

    expect(result).toMatchObject({ status: 'installed', written: true });
    const groups = readJson('.claude/settings.json').hooks.Stop;
    expect(groups).toHaveLength(1);
    expect(groups[0].hooks[0].command).toBe(`python "${shimPath}" claude Stop`);
  });

  it('quotes the interpreter only when it contains whitespace', async () => {
    const spaced: HookInstallerDeps = {
      homeDir: () => home,
      shimPath: join(home, 'My Tools', 'helm-hook-shim.py'),
      runCommand: async (command) => (command === 'python' ? { code: 0 } : { code: 1 }),
    };

    await installCliHooks(CLAUDE, spaced);

    const settings = readJson('.claude/settings.json');
    expect(settings.hooks.PreToolUse[0].hooks[0].command)
      .toBe(`python "${join(home, 'My Tools', 'helm-hook-shim.py')}" claude PreToolUse`);
  });

  it('rewrites a legacy fully-quoted install to the unquoted form (self-healing)', async () => {
    // Old Helm wrote fully-quoted commands; codex spawns hooks with no shell
    // quote handling, so those died with "Hook failed, exit 1". Reinstalling
    // over a machine that still carries the old format must heal the file.
    mkdirSync(join(home, '.codex'), { recursive: true });
    writeFileSync(
      join(home, '.codex', 'hooks.json'),
      JSON.stringify({
        hooks: {
          SessionStart: [{
            matcher: '*',
            hooks: [{ type: 'command', command: `"python" "${shimPath}" codex SessionStart`, timeout: 10 }],
          }],
        },
      }),
    );

    const result = await installCliHooks(CODEX, depsWithPython());

    expect(result).toMatchObject({ status: 'installed', written: true });
    const hooks = readJson('.codex/hooks.json');
    for (const event of CODEX.events) {
      const groups = hooks.hooks[event];
      const commands = groups.flatMap((g: any) => g.hooks.map((h: any) => h.command));
      expect(commands).toContain(`python ${shimPath} codex ${event}`);
    }
  });

  it('flags a spaced shim path for codex, which cannot spawn quoted hook programs', async () => {
    vi.mocked(logger.warn).mockClear();
    const spaced: HookInstallerDeps = {
      homeDir: () => home,
      shimPath: join(home, 'My Tools', 'helm-hook-shim.py'),
      runCommand: async (command) => (command === 'python' ? { code: 0 } : { code: 1 }),
    };

    await installCliHooks(CODEX, spaced);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('spaces'));
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

  it('accepts a pre-resolved interpreter, skips the probe entirely, and answers identically', async () => {
    await installCliHooks(CLAUDE, depsWithPython());

    let probeCalls = 0;
    const deps: HookInstallerDeps = {
      homeDir: () => home,
      shimPath,
      runCommand: async () => {
        probeCalls++;
        return { code: 0 };
      },
    };
    // Same interpreter the installer itself would have probed and found.
    expect(await readHookIntegrationStatus(CLAUDE, deps, { command: 'python', args: [] })).toBe('installed');
    expect(probeCalls).toBe(0);
    // And the caller's other hand — probing itself — agrees.
    expect(await readHookIntegrationStatus(CLAUDE, depsWithPython())).toBe('installed');
  });

  it('takes null as a definitive missing interpreter: interpreter-missing, no probe', async () => {
    let probeCalls = 0;
    const deps: HookInstallerDeps = {
      homeDir: () => home,
      shimPath,
      runCommand: async () => {
        probeCalls++;
        return { code: 0 };
      },
    };
    expect(await readHookIntegrationStatus(CLAUDE, deps, null)).toBe('interpreter-missing');
    expect(probeCalls).toBe(0);
  });
});

describe('buildHookSnippet', () => {
  /** The drift guard: the copy-ready snippet IS what installCliHooks writes. */
  async function expectSnippetToMatchInstall(hooks: CliHooksIntegration): Promise<void> {
    const deps = depsWithPython();
    await installCliHooks(hooks, deps);

    const interpreter = await probeInterpreter(deps);
    const { configPath, snippet } = buildHookSnippet(hooks, deps, interpreter);

    expect(configPath).toBe(hooks.configPath);
    const onDisk = readJson(hooks.configPath.replace(/^~[\\/]/, ''));
    const expected: Record<string, unknown> = { hooks: onDisk.hooks };
    if (hooks.provider === 'copilot') expected.version = 1;
    expect(JSON.parse(snippet)).toEqual(expected);
  }

  it('matches what a Claude install writes (parsed-JSON equality)', async () => {
    await expectSnippetToMatchInstall(CLAUDE);
  });

  it('matches what a Codex install writes', async () => {
    await expectSnippetToMatchInstall(CODEX);
  });

  it('matches the Copilot Helm-owned file, including the version stamp', async () => {
    await expectSnippetToMatchInstall(COPILOT);
  });

  it('renders a <python> placeholder when the interpreter is missing, never a fabricated path', () => {
    const { snippet } = buildHookSnippet(CLAUDE, depsWithPython(), null);

    expect(snippet).toContain('<python>');
    // The shim path is real (Helm's own seeded copy) — JSON-escaped on Windows.
    expect(snippet).toContain(shimPath.replace(/\\/g, '\\\\'));
    // The only bare interpreter-looking token is the placeholder itself.
    for (const line of snippet.split('\n')) {
      if (line.trim().startsWith('"command"')) {
        expect(line.trim().startsWith('"command": "<python> ')).toBe(true);
      }
    }
  });

  it('keeps the Copilot version stamp under the placeholder too', () => {
    const { snippet } = buildHookSnippet(COPILOT, depsWithPython(), null);

    expect(snippet).toContain('"version": 1');
    expect(snippet).toContain('<python>');
  });
});
