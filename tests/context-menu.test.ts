/**
 * Context menu — modal-bridge showContextMenu / hideContextMenu tests.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mockGetTerminalManager = vi.fn();

// Spread the real module: a bare stub breaks any transitive import that needs
// another Vue export (modal-bridge pulls in composables that call `ref`).
vi.mock('vue', async () => {
  const actual = await vi.importActual<typeof import('vue')>('vue');
  return { ...actual, reactive: (obj: any) => obj };
});

vi.mock('../renderer/runtime/terminal-provider.js', () => ({
  getTerminalManager: mockGetTerminalManager,
}));

function makeMockView(selection = '', hasSelection = false) {
  return {
    getSelection: vi.fn(() => selection),
    hasSelection: vi.fn(() => hasSelection),
  };
}

function makeMockTerminalManager(view = makeMockView()) {
  return { getActiveView: vi.fn(() => view) };
}

async function getBridge() {
  return await import('../renderer/stores/modal-bridge.js');
}

describe('Context Menu (modal-bridge)', () => {
  let bridge: Awaited<ReturnType<typeof getBridge>>;

  beforeEach(async () => {
    bridge = await getBridge();
    Object.assign(bridge.contextMenu, {
      visible: false,
      selectedText: '', hasSelection: false, sourceSessionId: '',
      position: null, mode: 'terminal',
    });
    mockGetTerminalManager.mockReturnValue(makeMockTerminalManager());
  });

  afterEach(() => {
    bridge.hideContextMenu();
    vi.clearAllMocks();
  });

  it('showContextMenu sets terminal source, selection, and pointer position', () => {
    bridge.showContextMenu('sess-1', 'captured', true, { x: 20, y: 40 });
    expect(bridge.contextMenu.visible).toBe(true);
    expect(bridge.contextMenu.sourceSessionId).toBe('sess-1');
    expect(bridge.contextMenu.mode).toBe('terminal');
    expect(bridge.contextMenu.selectedText).toBe('captured');
    expect(bridge.contextMenu.position).toEqual({ x: 20, y: 40 });
  });

  it('showSessionMenu resets terminal-only state and records its trigger position', () => {
    bridge.showContextMenu('sess-terminal', 'old selection', true, { x: 1, y: 2 });
    bridge.showSessionMenu('sess-row', { x: 30, y: 50 });
    expect(bridge.contextMenu.mode).toBe('session');
    expect(bridge.contextMenu.sourceSessionId).toBe('sess-row');
    expect(bridge.contextMenu.selectedText).toBe('');
    expect(bridge.contextMenu.hasSelection).toBe(false);
    expect(bridge.contextMenu.position).toEqual({ x: 30, y: 50 });
  });

  it('hideContextMenu clears visibility', () => {
    bridge.showContextMenu('sess-1');
    bridge.hideContextMenu();
    expect(bridge.contextMenu.visible).toBe(false);
  });

  it('reads selection from terminal manager when no pre-captured values', () => {
    const view = makeMockView('selected code', true);
    mockGetTerminalManager.mockReturnValue(makeMockTerminalManager(view));
    bridge.showContextMenu('sess-1');
    expect(bridge.contextMenu.selectedText).toBe('selected code');
    expect(bridge.contextMenu.hasSelection).toBe(true);
  });

  it('pre-captured selection overrides terminal manager', () => {
    const view = makeMockView('stale', true);
    mockGetTerminalManager.mockReturnValue(makeMockTerminalManager(view));
    bridge.showContextMenu('sess-1', 'fresh selection', true);
    expect(bridge.contextMenu.selectedText).toBe('fresh selection');
    expect(view.getSelection).not.toHaveBeenCalled();
  });

  it('defaults to empty selection when terminal manager is null', () => {
    mockGetTerminalManager.mockReturnValue(null);
    bridge.showContextMenu('sess-1');
    expect(bridge.contextMenu.selectedText).toBe('');
    expect(bridge.contextMenu.hasSelection).toBe(false);
  });

  it('defaults to empty when terminal manager returns null view', () => {
    mockGetTerminalManager.mockReturnValue({ getActiveView: () => null });
    bridge.showContextMenu('sess-1');
    expect(bridge.contextMenu.selectedText).toBe('');
  });
});
