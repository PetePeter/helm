/**
 * useUpdateCheck — the auto/manual gate on the launch check and the
 * always-answer contract of "Check now". The IPC client is faked at the
 * preload boundary; toasts are the real singleton.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const update = vi.hoisted(() => ({
  updateGetMode: vi.fn(),
  updateCheck: vi.fn(),
  updateInstall: vi.fn(),
}));

vi.mock('../renderer/ipc/clients', () => ({
  updateClient: update,
  eventsClient: { onUpdateProgress: () => () => {} },
}));

import { checkForAppUpdate, checkForAppUpdateNow } from '../renderer/composables/useUpdateCheck';
import { useToast } from '../renderer/composables/useToast';

const NEWER = {
  packaged: true,
  current: '3.11.1',
  update: { version: '3.12.0', releaseUrl: '', installerUrl: 'https://github.com/PetePeter/helm/releases/download/v3.12.0/x.exe' },
};

function offerToast() {
  return useToast().toasts.find(t => t.key === 'helm-update');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  const { toasts, removeToast } = useToast();
  [...toasts].forEach(t => removeToast(t.id));
});

afterEach(() => vi.useRealTimers());

describe('launch check', () => {
  it('does not contact GitHub when the mode is manual', async () => {
    update.updateGetMode.mockResolvedValue('manual');
    checkForAppUpdate();
    await vi.runAllTimersAsync();
    expect(update.updateCheck).not.toHaveBeenCalled();
    expect(offerToast()).toBeUndefined();
  });

  it('offers a newer release when the mode is auto', async () => {
    update.updateGetMode.mockResolvedValue('auto');
    update.updateCheck.mockResolvedValue(NEWER);
    checkForAppUpdate();
    await vi.runAllTimersAsync();
    expect(offerToast()?.message).toContain('v3.12.0');
  });
});

describe('Check now', () => {
  it('reports up to date instead of staying silent', async () => {
    update.updateCheck.mockResolvedValue({ packaged: true, current: '3.11.1', update: null });
    expect(await checkForAppUpdateNow()).toBe('Helm v3.11.1 is up to date');
  });

  it('checks and offers even when the launch check is manual', async () => {
    update.updateGetMode.mockResolvedValue('manual');
    update.updateCheck.mockResolvedValue(NEWER);
    expect(await checkForAppUpdateNow()).toBe('Helm v3.12.0 is available');
    expect(offerToast()).toBeDefined();
  });
});
