// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { useFirstRunOnboarding } from '../renderer/composables/useFirstRunOnboarding';

function setup(overrides: Record<string, unknown> = {}) {
  const deps = {
    getCompleted: vi.fn().mockResolvedValue(false),
    setCompleted: vi.fn().mockResolvedValue({ success: true }),
    getTools: vi.fn().mockResolvedValue([{ id: 'claude-id', name: 'Claude Code' }]),
    getProjects: vi.fn().mockResolvedValue([{ name: 'Demo', canonicalPath: 'C:\\work\\demo', alternatePaths: [] }]),
    browseDirectory: vi.fn().mockResolvedValue(null),
    createProject: vi.fn().mockResolvedValue({ success: true }),
    spawnSession: vi.fn().mockResolvedValue(true),
    openSettings: vi.fn(),
    ...overrides,
  };
  return { onboarding: useFirstRunOnboarding(deps), deps };
}

describe('useFirstRunOnboarding', () => {
  it('shows an incomplete first run with the configured CLI and project ready to select', async () => {
    const { onboarding } = setup();

    await onboarding.initialize();

    expect(onboarding.visible.value).toBe(true);
    expect(onboarding.selectedCli.value).toBe('claude-id');
    expect(onboarding.directories.value).toEqual([{ name: 'Demo', path: 'C:\\work\\demo' }]);
  });

  it('does not interrupt an existing install whose onboarding setting is complete', async () => {
    const { onboarding } = setup({ getCompleted: vi.fn().mockResolvedValue(true) });

    await onboarding.initialize();

    expect(onboarding.visible.value).toBe(false);
  });

  it('starts the first session with the chosen CLI, directory, and prompt, then offers configuration', async () => {
    const { onboarding, deps } = setup();
    await onboarding.initialize();
    onboarding.selectedDirectory.value = 'C:\\work\\demo';
    onboarding.prompt.value = 'Explain this project';
    onboarding.stage.value = 'prompt';

    await onboarding.startSession();

    expect(deps.spawnSession).toHaveBeenCalledWith('claude-id', 'C:\\work\\demo', 'Explain this project');
    expect(deps.setCompleted).toHaveBeenCalledWith(true);
    expect(onboarding.stage.value).toBe('success');
  });

  it('keeps the user in onboarding and offers Tools settings when spawn fails', async () => {
    const { onboarding, deps } = setup({ spawnSession: vi.fn().mockResolvedValue(false) });
    await onboarding.initialize();
    onboarding.selectedDirectory.value = 'C:\\work\\demo';
    onboarding.stage.value = 'prompt';

    await onboarding.startSession();

    expect(onboarding.stage.value).toBe('prompt');
    expect(onboarding.error.value).toMatch(/could not start/i);
    expect(deps.setCompleted).not.toHaveBeenCalled();
  });

  it('routes optional configuration topics to their existing settings tabs', async () => {
    const { onboarding, deps } = setup();

    onboarding.openSettings('cli-integrations');

    expect(deps.openSettings).toHaveBeenCalledWith('cli-integrations');
    expect(onboarding.visible.value).toBe(false);
  });
});
