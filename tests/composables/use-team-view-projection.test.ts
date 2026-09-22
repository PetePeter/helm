/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { effectScope, watch } from 'vue';
import { createPinia, setActivePinia } from 'pinia';
import { useTeamViewProjection } from '../../renderer/composables/useTeamViewProjection.js';
import { useAppStore } from '../../renderer/stores/app.js';
import { PtyOutputBuffer } from '../../renderer/terminal/pty-output-buffer.js';
import { setTerminalManager } from '../../renderer/runtime/terminal-provider.js';
import type { Session } from '../../renderer/state.js';

function makeSession(id: string): Session {
  return { id, name: id, cliType: 'codex', processId: 0, projectId: 'alpha' };
}

/** The composable only needs the buffer accessor, not a real TerminalManager. */
function fakeTerminalManager(buffer: PtyOutputBuffer): any {
  return { getOutputBuffer: () => buffer };
}

function seedStore(sessionIds: string[]): void {
  const appStore = useAppStore();
  appStore.state.sessions = sessionIds.map(makeSession);
  appStore.state.projects = [{ id: 'alpha', name: 'Alpha', canonicalPath: '/alpha', alternatePaths: [] }];
}

describe('useTeamViewProjection live plumbing', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    setActivePinia(createPinia());
    setTerminalManager(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    setTerminalManager(null);
  });

  it('picks up the output buffer when the terminal manager appears after composable setup', () => {
    seedStore(['s1']);

    const buffer = new PtyOutputBuffer();
    const scope = effectScope();
    const projection = scope.run(() => useTeamViewProjection())!;

    // Before bootstrap the desk is empty — not an error, just no mirror yet.
    expect(projection.value.departments[0].desks[0].terminalTail).toEqual([]);

    // App mount order: dock panes (and their composables) run BEFORE
    // useAppBootstrap constructs the TerminalManager. The mirror must attach
    // once the manager exists, without remounting the pane.
    setTerminalManager(fakeTerminalManager(buffer));
    buffer.append('s1', 'hello from the pty\n');
    vi.advanceTimersByTime(1000);

    expect(projection.value.departments[0].desks[0].terminalTail).toEqual(['hello from the pty']);
    scope.stop();
  });

  it('throttles invalidation so PTY chunks within one window recompute once', () => {
    seedStore(['s1']);

    const buffer = new PtyOutputBuffer();
    const scope = effectScope();
    const projection = scope.run(() => useTeamViewProjection())!;
    setTerminalManager(fakeTerminalManager(buffer));

    const watcher = effectScope();
    const track = vi.fn();
    watcher.run(() => watch(projection, track, { flush: 'sync' }));

    for (let i = 0; i < 20; i++) buffer.append('s1', `line ${i}\n`);
    vi.advanceTimersByTime(1000);
    expect(track).toHaveBeenCalledTimes(1);

    buffer.append('s1', 'after the window\n');
    vi.advanceTimersByTime(1000);
    expect(track).toHaveBeenCalledTimes(2);

    scope.stop();
    watcher.stop();
  });

  it('reflects the shared per-session activity level on desks', () => {
    seedStore(['s1']);
    const appStore = useAppStore();
    appStore.state.sessionActivityLevels.set('s1', 'active');

    const scope = effectScope();
    const projection = scope.run(() => useTeamViewProjection())!;
    expect(projection.value.departments[0].desks[0].activityLevel).toBe('active');

    appStore.state.sessionActivityLevels.set('s1', 'idle');
    expect(projection.value.departments[0].desks[0].activityLevel).toBe('idle');
    scope.stop();
  });
});
