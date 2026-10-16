import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { effectScope } from 'vue';
import { useAutosave, settingsSaveState } from '../../renderer/composables/useAutosave.js';

describe('useAutosave', () => {
  beforeEach(() => { vi.useFakeTimers(); settingsSaveState.status = 'idle'; });
  afterEach(() => { vi.useRealTimers(); });

  it('debounces bursts of edits into one save', async () => {
    const save = vi.fn(async () => {});
    const { schedule } = useAutosave(save, { debounceMs: 500 });
    schedule(); schedule(); schedule();
    await vi.advanceTimersByTimeAsync(499);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(settingsSaveState.status).toBe('saved');
  });

  it('immediate saves skip the debounce', async () => {
    const save = vi.fn(async () => {});
    useAutosave(save).schedule(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
  });

  it('reports errors from a throw or a false return, with the message', async () => {
    const { schedule } = useAutosave(async () => { throw new Error('disk full'); });
    schedule(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settingsSaveState).toMatchObject({ status: 'error', message: 'disk full' });

    useAutosave(async () => false).schedule(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settingsSaveState.status).toBe('error');
  });

  it('an edit during an in-flight save triggers exactly one follow-up save', async () => {
    let release!: () => void;
    const save = vi.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const { schedule } = useAutosave(save);
    schedule(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(settingsSaveState.status).toBe('saving');
    schedule(true); schedule(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(0);
    expect(settingsSaveState.status).toBe('saved');
  });

  it('flushes a pending edit when its owner is disposed, so leaving a page never drops it', async () => {
    const save = vi.fn(async () => {});
    const scope = effectScope();
    const autosave = scope.run(() => useAutosave(save, { debounceMs: 500 }))!;
    autosave.schedule();
    scope.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('trackSave', () => {
  it('reports a page-owned save on the shared status, without rethrowing', async () => {
    const { trackSave } = await import('../../renderer/composables/useAutosave.js');
    await expect(trackSave(async () => { throw new Error('Skill name is required'); })).resolves.toBe(false);
    expect(settingsSaveState).toMatchObject({ status: 'error', message: 'Skill name is required' });
    await expect(trackSave(async () => undefined)).resolves.toBe(true);
    expect(settingsSaveState.status).toBe('saved');
  });
});
