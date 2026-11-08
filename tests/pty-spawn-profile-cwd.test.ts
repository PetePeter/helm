import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const electronState = vi.hoisted(() => ({ handlers: new Map<string, Function>() }));

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: Function) => electronState.handlers.set(channel, handler)),
  },
}));

import { setupPtyHandlers } from '../src/electron/ipc/pty-handlers.js';
import { SessionManager } from '../src/session/manager.js';
import { PtyManager, type PtyFactory } from '../src/session/pty-manager.js';
import { ProjectStore } from '../src/session/project-store.js';

describe('desktop pty:spawn profile cwd', () => {
  beforeEach(() => electronState.handlers.clear());

  it('rejects a renderer cwd outside its profile project folders before starting a PTY', () => {
    const base = mkdtempSync(join(tmpdir(), 'helm-desktop-spawn-'));
    try {
      const project = join(base, 'profile-two-project');
      const outside = join(base, 'profile-one-project');
      mkdirSync(project);
      mkdirSync(outside);
      const projectStore = new ProjectStore();
      projectStore.resolveForPath(project);
      const sessionManager = new SessionManager({
        userProfileId: '2',
        sessionsFile: join(base, 'sessions.json'),
        projectStore,
      });
      const spawn = vi.fn(() => ({ pid: 99, write() {}, resize() {}, kill() {}, onData() {}, onExit() {} }));
      const ptyManager = new PtyManager({ spawn } as unknown as PtyFactory);
      const stateDetector = Object.assign(new EventEmitter(), {
        markActive: vi.fn(),
        markResizing: vi.fn(),
        markSwitching: vi.fn(),
        processOutput: vi.fn(),
        removeSession: vi.fn(),
      });
      const pipelineQueue = {
        dequeue: vi.fn(), enqueue: vi.fn(), getPosition: vi.fn(() => 0), getAll: vi.fn(() => []),
      };
      const windowManager = {
        isSessionOwnedByWebContents: vi.fn(() => false),
        getWindowForSession: vi.fn(() => undefined),
        getWindowIdForSession: vi.fn(() => undefined),
        getWindow: vi.fn(() => undefined),
        unassignSession: vi.fn(),
      };
      setupPtyHandlers(
        ptyManager,
        stateDetector as any,
        sessionManager,
        pipelineQueue as any,
        windowManager as any,
        { reloadActiveProfileIfChanged: vi.fn() } as any,
      );

      const spawnHandler = electronState.handlers.get('pty:spawn');
      expect(spawnHandler).toBeDefined();
      const result = spawnHandler!({}, 'session-outside', 'cli', [], outside, 'cli') as { success: boolean; error?: string };

      expect(result.success).toBe(false);
      expect(result.error?.toLowerCase()).toContain(outside.toLowerCase());
      expect(result.error).toContain('outside the profile\'s project folders');
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
