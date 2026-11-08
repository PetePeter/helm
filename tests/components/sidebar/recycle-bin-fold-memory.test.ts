/**
 * RecycleBinModal fold memory — the tree's expand/collapse state is remembered
 * across modal close/reopen and is not disturbed by searching.
 *
 * Real component + real tree-collapse-state module; only the IPC surface is
 * faked (the composable calls into Electron on mount).
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import RecycleBinModal from '../../../renderer/components/sidebar/RecycleBinModal.vue';
import { __resetTreeExpansionCache } from '../../../renderer/tree-collapse-state.js';
import type { RecycleBinEntry } from '../../../src/types/recycle-bin.js';

const mocks = vi.hoisted(() => ({ recycleBinList: vi.fn() }));

vi.mock('../../../renderer/ipc/clients.js', () => ({
  recycleBinClient: {
    recycleBinList: mocks.recycleBinList,
    recycleBinRestore: vi.fn(),
    recycleBinForget: vi.fn(),
    recycleBinEmpty: vi.fn(),
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

/** The <details> element for the project level. */
function projectDetails(): HTMLDetailsElement {
  const el = document.querySelector('details.rb-project');
  if (!el) throw new Error('project node not rendered');
  return el as HTMLDetailsElement;
}

beforeEach(() => {
  localStorage.clear();
  __resetTreeExpansionCache();
  document.body.innerHTML = '';
  mocks.recycleBinList.mockResolvedValue([makeEntry()]);
});

describe('RecycleBinModal fold memory', () => {
  it('starts collapsed and remembers an expanded node after close and reopen', async () => {
    const first = await mountBin();
    expect(projectDetails().open).toBe(false);

    // Expand exactly as the browser does: flip `open`, then fire toggle.
    const node = projectDetails();
    node.open = true;
    node.dispatchEvent(new Event('toggle'));
    await flushPromises();

    first.unmount();
    document.body.innerHTML = '';
    __resetTreeExpansionCache(); // simulate a full app reload, not just a remount

    await mountBin();
    expect(projectDetails().open).toBe(true);
  });

  it('keeps fold state while a search query filters the tree', async () => {
    await mountBin();
    const node = projectDetails();
    node.open = true;
    node.dispatchEvent(new Event('toggle'));
    await flushPromises();

    // Teleported to body, so drive the real input element directly.
    const search = document.querySelector('.rb-search input') as HTMLInputElement;
    search.value = 'session-1';
    search.dispatchEvent(new Event('input'));
    await flushPromises();

    expect(projectDetails().open).toBe(true);
  });
});
