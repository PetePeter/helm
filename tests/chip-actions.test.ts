/**
 * Chip-bar actions — current Pinia store behavior.
 *
 * @vitest-environment jsdom
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { setPlanEditorOpener, useChipBarStore } from '../renderer/stores/chip-bar.js';
import { state } from '../renderer/state.js';
import { executeSequenceForSession } from '../renderer/bindings.js';

const mockShowPlanInEditor = vi.fn();
const mockDeliverBulkText = vi.fn();

vi.mock('../renderer/bindings.js', () => ({
  executeSequenceForSession: vi.fn(),
}));

vi.mock('../renderer/paste-handler.js', () => ({
  deliverBulkText: (...args: unknown[]) => mockDeliverBulkText(...args),
}));

describe('Chip-bar action store behavior', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    state.sessions = [
      {
        id: 'session-1',
        name: 'My Session',
        cliType: 'claude-code',
        processId: 1,
        workingDir: 'C:\\myproject',
      },
    ];
    state.activeSessionId = 'session-1';
    state.planCodingCounts.clear();
    state.planStartableCounts.clear();
    setPlanEditorOpener(mockShowPlanInEditor);

    (globalThis as typeof globalThis & { window: any }).window = {
      gamepadCli: {
        planDoingForSession: vi.fn().mockResolvedValue([]),
        planGetAllDoingForDir: vi.fn().mockResolvedValue([]),
        planStartableForDir: vi.fn().mockResolvedValue([]),
        configGetChipbarActions: vi.fn().mockResolvedValue({
          actions: [{ label: 'Plans', sequence: 'open {plansDir}{Enter}' }],
          inboxDir: 'C:\\config\\plans\\incoming',
        }),
        planGetItem: vi.fn(),
        planUpdate: vi.fn().mockResolvedValue(undefined),
        planSetState: vi.fn().mockResolvedValue(undefined),
        planDelete: vi.fn().mockResolvedValue(undefined),
        planComplete: vi.fn().mockResolvedValue(undefined),
        planApply: vi.fn().mockResolvedValue(undefined),
        writeTempContent: vi.fn().mockResolvedValue({ success: true, path: 'C:\\temp\\plan.txt' }),
      },
    };
  });

  it('loads action previews with resolved inbox aliases', async () => {
    const store = useChipBarStore();

    await store.refresh('session-1');

    expect(store.actions).toEqual([
      {
        label: 'Plans',
        sequence: 'open {plansDir}{Enter}',
        preview: 'open C:\\config\\plans\\incoming{Enter}',
      },
    ]);
  });

  it('triggerAction resolves templates against the active session context', async () => {
    const store = useChipBarStore();

    await store.refresh('session-1');
    await store.triggerAction('cd {cwd}{Enter}');

    expect(executeSequenceForSession).toHaveBeenCalledWith('session-1', 'cd C:\\myproject{Enter}');
  });

  it('treats chipbar template variables case-insensitively', async () => {
    const store = useChipBarStore();

    await store.refresh('session-1');
    await store.triggerAction('cd {CWD}{enter}');

    expect(executeSequenceForSession).toHaveBeenCalledWith('session-1', 'cd C:\\myproject{enter}');
  });

  it('openPlan shows the plan editor with current callbacks', async () => {
    const store = useChipBarStore();
    window.gamepadCli.planGetAllDoingForDir.mockResolvedValue([
      { id: 'plan-1', title: 'Fix API', status: 'coding', sessionId: 'session-1' },
    ]);
    window.gamepadCli.planGetItem.mockResolvedValue({
      id: 'plan-1',
      title: 'Fix API',
      description: 'Handle retries',
      status: 'coding',
      sessionId: 'session-1',
    });

    await store.refresh('session-1');
    await store.openPlan('plan-1');

    expect(mockShowPlanInEditor).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({ id: 'plan-1', status: 'coding' }),
      expect.objectContaining({
        onSave: expect.any(Function),
        onDelete: expect.any(Function),
      }),
    );
  });
});
