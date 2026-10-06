import { beforeEach, describe, expect, it, vi } from 'vitest';

const handlers = new Map<string, Function>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => { handlers.set(channel, handler); }),
  },
}));

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { setupProjectHandlers } from '../src/electron/ipc/project-handlers.js';

describe('project:removeDir', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('removes an alternate folder that no longer exists on disk', () => {
    const projectStore = {
      onChanged: vi.fn(),
      removeDirectory: vi.fn(),
      save: vi.fn(),
    };
    setupProjectHandlers(projectStore as any);

    const result = handlers.get('project:removeDir')!({}, 'project-1', 'X:\\coding\\removed-folder');

    expect(result).toEqual({ success: true });
    expect(projectStore.removeDirectory).toHaveBeenCalledWith('project-1', 'X:\\coding\\removed-folder');
    expect(projectStore.save).toHaveBeenCalledOnce();
  });
});
