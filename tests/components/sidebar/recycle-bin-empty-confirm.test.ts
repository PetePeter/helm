/**
 * Emptying the recycle bin is irreversible — it deletes every binned entry and
 * their artifacts — so the header's "Empty bin" button must open a confirmation
 * rather than firing the IPC straight away.
 *
 * Real RecycleBinModal + real ConfirmDialog; only the IPC surface is faked
 * (the composable calls into Electron on mount).
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import RecycleBinModal from '../../../renderer/components/sidebar/RecycleBinModal.vue';
import { __resetTreeExpansionCache } from '../../../renderer/tree-collapse-state.js';
import type { RecycleBinEntry } from '../../../src/types/recycle-bin.js';

const mocks = vi.hoisted(() => ({
  recycleBinList: vi.fn(),
  recycleBinEmpty: vi.fn(),
}));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  recycleBinClient: {
    recycleBinList: mocks.recycleBinList,
    recycleBinRestore: vi.fn(),
    recycleBinForget: vi.fn(),
    recycleBinEmpty: mocks.recycleBinEmpty,
  },
  runtimeGroupClient: {},
  eventsClient: {},
  sessionsClient: {},
}));

vi.mock('../../../renderer/screens/sessions-spawn.js', () => ({ doSpawn: vi.fn() }));
vi.mock('../../../renderer/runtime/terminal-provider.js', () => ({ getTerminalManager: () => null }));

function makeEntry(overrides: Partial<RecycleBinEntry> = {}): RecycleBinEntry {
  return {
    id: 'bin-1',
    sessionId: 'sess-1',
    name: 'session-1',
    cliType: 'claude-code',
    workingDir: 'x:/coding/helm',
    cliSessionName: 'uuid-1',
    closedAt: Date.now(),
    projectId: 'proj-1',
    projectName: 'Helm',
    ...overrides,
  } as RecycleBinEntry;
}

async function mountBin() {
  const wrapper = mount(RecycleBinModal, { props: { visible: true }, attachTo: document.body });
  await flushPromises();
  return wrapper;
}

/** Everything teleports to body, so query the real DOM. */
function confirmDialog(): HTMLElement | null {
  return document.querySelector('[aria-label="Empty recycle bin confirmation"]');
}

function clickByText(root: ParentNode, selector: string, text: string): void {
  const el = Array.from(root.querySelectorAll(selector))
    .find(node => node.textContent?.trim() === text);
  if (!el) throw new Error(`no ${selector} labelled "${text}"`);
  (el as HTMLElement).click();
}

async function openConfirm() {
  clickByText(document.body, 'button.rb-clear', 'Empty bin');
  await flushPromises();
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetTreeExpansionCache();
  document.body.innerHTML = '';
  mocks.recycleBinList.mockResolvedValue([makeEntry(), makeEntry({ id: 'bin-2', sessionId: 'sess-2' })]);
  mocks.recycleBinEmpty.mockResolvedValue({ ok: true });
});

describe('RecycleBinModal — empty confirmation', () => {
  it('E1 "Empty bin" opens a confirmation instead of emptying the bin', async () => {
    await mountBin();

    await openConfirm();

    expect(confirmDialog()).not.toBeNull();
    expect(mocks.recycleBinEmpty).not.toHaveBeenCalled();
  });

  it('E2 the confirmation names how many sessions will be deleted', async () => {
    await mountBin();
    await openConfirm();

    expect(confirmDialog()!.textContent).toContain('2');
  });

  it('E3 confirming empties the bin once and closes the modal', async () => {
    const wrapper = await mountBin();
    await openConfirm();

    clickByText(confirmDialog()!, 'button', 'Empty bin');
    await flushPromises();

    expect(mocks.recycleBinEmpty).toHaveBeenCalledTimes(1);
    expect(wrapper.emitted('update:visible')).toEqual([[false]]);
  });

  it('keeps the confirmation open when Empty is rejected', async () => {
    mocks.recycleBinEmpty.mockResolvedValue({ ok: false, error: 'A session is being restored.' });
    const wrapper = await mountBin();
    await openConfirm();

    clickByText(confirmDialog()!, 'button', 'Empty bin');
    await flushPromises();

    expect(confirmDialog()).not.toBeNull();
    expect(wrapper.emitted('update:visible')).toBeUndefined();
  });

  it('E4 cancelling leaves the bin untouched and dismisses the confirmation', async () => {
    const wrapper = await mountBin();
    await openConfirm();

    clickByText(confirmDialog()!, 'button', 'Cancel');
    await flushPromises();

    expect(mocks.recycleBinEmpty).not.toHaveBeenCalled();
    expect(confirmDialog()).toBeNull();
    expect(wrapper.emitted('update:visible')).toBeUndefined();
  });

  it('E5 a dismissed confirmation does not reappear when the bin is reopened', async () => {
    const wrapper = await mountBin();
    await openConfirm();
    expect(confirmDialog()).not.toBeNull();

    // Close the bin outright while the confirmation is still up, then reopen.
    await wrapper.setProps({ visible: false });
    await flushPromises();
    await wrapper.setProps({ visible: true });
    await flushPromises();

    expect(confirmDialog()).toBeNull();
  });

  it('E6 the button stays disabled when there is nothing to empty', async () => {
    mocks.recycleBinList.mockResolvedValue([]);
    await mountBin();

    const btn = document.querySelector('button.rb-clear') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });
});
