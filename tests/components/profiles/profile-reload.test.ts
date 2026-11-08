import { describe, expect, it, vi } from 'vitest';
import { installProfileReload } from '../../../renderer/profile-reload.js';

describe('installProfileReload', () => {
  it('reloads the window when the profile changes and stops after unsubscribe', () => {
    let listener: (() => void) | undefined;
    const unsubscribe = vi.fn(() => { listener = undefined; });
    const client = { profileOnChanged: (cb: () => void) => { listener = cb; return unsubscribe; } };
    const reload = vi.fn();

    const stop = installProfileReload(client, reload);
    listener!();
    expect(reload).toHaveBeenCalledOnce();

    stop();
    expect(listener).toBeUndefined();
  });
});
