import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  registerView, showView, currentView, onViewChange, __resetMainViewManager,
} from '../renderer/main-view/main-view-manager.js';

describe('MainViewManager', () => {
  beforeEach(() => {
    __resetMainViewManager();
  });

  it('defaults to terminal view', () => {
    expect(currentView()).toBe('terminal');
  });

  it('transitions unmount -> mount in order', async () => {
    const calls: string[] = [];
    registerView('terminal', { mount: () => { calls.push('terminal:mount'); }, unmount: () => { calls.push('terminal:unmount'); } });
    registerView('plan', { mount: () => { calls.push('plan:mount'); }, unmount: () => { calls.push('plan:unmount'); } });

    await showView('plan');
    // First switch: prior was 'terminal' (default), but no prior mount ran, so unmount still runs
    expect(calls).toEqual(['terminal:unmount', 'plan:mount']);
    expect(currentView()).toBe('plan');
  });

  it('passes params to mount', async () => {
    const mount = vi.fn();
    registerView('plan', { mount, unmount: () => {} });
    await showView('plan', { dir: '/home' });
    expect(mount).toHaveBeenCalledWith(
      { dir: '/home' },
      expect.objectContaining({
        transitionId: expect.any(Number),
        isActive: expect.any(Function),
      }),
    );
  });

  it('fires onChange listeners on transition', async () => {
    registerView('plan', { mount: () => {}, unmount: () => {} });
    const cb = vi.fn();
    onViewChange(cb);
    await showView('plan');
    expect(cb).toHaveBeenCalledWith('plan');
  });

  it('notifies listeners before an async mount completes', async () => {
    let releasePlanMount: (() => void) | null = null;
    registerView('plan', {
      mount: async () => {
        await new Promise<void>((resolve) => {
          releasePlanMount = resolve;
        });
      },
      unmount: () => {},
    });
    const cb = vi.fn();
    onViewChange(cb);

    const pending = showView('plan');
    await Promise.resolve();

    expect(currentView()).toBe('plan');
    expect(cb).toHaveBeenCalledWith('plan');

    releasePlanMount?.();
    await pending;
  });

  it('does not fire onChange when view is unchanged', async () => {
    registerView('terminal', { mount: () => {}, unmount: () => {} });
    const cb = vi.fn();
    onViewChange(cb);
    await showView('terminal');
    expect(cb).not.toHaveBeenCalled();
  });

  it('unsubscribe removes listener', async () => {
    registerView('plan', { mount: () => {}, unmount: () => {} });
    const cb = vi.fn();
    const unsub = onViewChange(cb);
    unsub();
    await showView('plan');
    expect(cb).not.toHaveBeenCalled();
  });

  it('isolates errors in mount from caller', async () => {
    registerView('plan', { mount: () => { throw new Error('boom'); }, unmount: () => {} });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(showView('plan')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('isolates errors in unmount from caller', async () => {
    registerView('plan', { mount: () => {}, unmount: () => { throw new Error('boom'); } });
    registerView('terminal', { mount: () => {}, unmount: () => {} });
    await showView('plan');
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(showView('terminal')).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('switches between registered views in order', async () => {
    const order: string[] = [];
    registerView('terminal', { mount: () => { order.push('T:m'); }, unmount: () => { order.push('T:u'); } });
    registerView('plan', { mount: () => { order.push('P:m'); }, unmount: () => { order.push('P:u'); } });

    await showView('plan');
    await showView('terminal');

    expect(currentView()).toBe('terminal');
    expect(order).toEqual(['T:u', 'P:m', 'P:u', 'T:m']);
  });

  it('ignores stale async mounts after a newer transition wins', async () => {
    let releasePlanMount: (() => void) | null = null;
    const calls: string[] = [];

    registerView('terminal', {
      mount: () => { calls.push('terminal:mount'); },
      unmount: () => { calls.push('terminal:unmount'); },
    });
    registerView('plan', {
      mount: async (_params, ctx) => {
        calls.push('plan:mount:start');
        await new Promise<void>((resolve) => {
          releasePlanMount = resolve;
        });
        if (ctx?.isActive()) calls.push('plan:mount:commit');
      },
      unmount: () => { calls.push('plan:unmount'); },
    });
    const pendingPlan = showView('plan');
    await Promise.resolve();
    await showView('terminal');
    releasePlanMount?.();
    await pendingPlan;

    expect(currentView()).toBe('terminal');
    expect(calls).toEqual([
      'terminal:unmount',
      'plan:mount:start',
      'plan:unmount',
      'terminal:mount',
    ]);
  });
});
