// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockState, mockGetTerminalManager } = vi.hoisted(() => ({
  mockState: {
    sessions: [] as Array<{ id: string; cliType: string }>,
    cliToolsCache: {} as Record<string, { submitSuffix?: string }>,
  },
  mockGetTerminalManager: vi.fn().mockReturnValue(null),
}));

vi.mock('../renderer/bindings', () => ({
  keyToPtyEscape: (key: string) => {
    const map: Record<string, string> = {
      'Enter': '\r', 'Tab': '\t', 'Escape': '\x1b', 'Backspace': '\x7f',
    };
    return map[key] ?? key;
  },
  comboToPtyEscape: (keys: string[]) => {
    if (keys.length === 2 && keys[0].toLowerCase() === 'ctrl') {
      const k = keys[1].toUpperCase();
      if (k.length === 1 && k >= 'A' && k <= 'Z') {
        return String.fromCharCode(k.charCodeAt(0) - 64);
      }
    }
    return keys.join('');
  },
}));

vi.mock('../renderer/state.js', () => ({ state: mockState }));
vi.mock('../renderer/runtime/terminal-provider.js', () => ({ getTerminalManager: mockGetTerminalManager }));
vi.mock('../renderer/stores/item-editor-registry.js', () => ({ isItemEditorVisible: () => false }));

import { deliverBulkText } from '../renderer/paste-handler';

// =============================================================================
// Regression tests: deliverBulkText must NEVER parse sequence tokens.
// It sends text literally — {Enter} stays as "{Enter}", not "\r".
// =============================================================================

describe('deliverBulkText sends text literally (no sequence parsing)', () => {
  let mockPtyWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPtyWrite = vi.fn().mockResolvedValue({ success: true });
    (window as any).gamepadCli = { ptyWrite: mockPtyWrite };
    mockState.sessions = [{ id: 'sess-1', cliType: 'claude-code' }];
    mockState.cliToolsCache = {};
  });

  it('sends {Enter} as literal text, not carriage return', async () => {
    await deliverBulkText('sess-1', 'hello{Enter}world');
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'hello{Enter}world');
  });

  it('sends {Tab} as literal text', async () => {
    await deliverBulkText('sess-1', 'hello{Tab}world');
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', 'hello{Tab}world');
  });

  it('sends {Ctrl+C} as literal text', async () => {
    await deliverBulkText('sess-1', '{Ctrl+C}');
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '{Ctrl+C}');
  });

  it('sends {Wait 500} as literal text', async () => {
    await deliverBulkText('sess-1', '{Wait 500}');
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '{Wait 500}');
  });

  it('sends escaped braces as literal text', async () => {
    await deliverBulkText('sess-1', '{{json}}');
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '{{json}}');
  });

  it('sends brace-heavy JSON content literally', async () => {
    const json = '{"key": "value", "nested": {"a": 1}}';
    await deliverBulkText('sess-1', json);
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', json);
  });

  it('sends template-like content literally', async () => {
    const text = 'function() { return {Enter}; }';
    await deliverBulkText('sess-1', text);
    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', text);
  });
});

describe('deliverBulkText wraps with bracketed paste markers in pty mode', () => {
  let mockPtyWrite: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPtyWrite = vi.fn().mockResolvedValue({ success: true });
    (window as any).gamepadCli = { ptyWrite: mockPtyWrite };
    mockState.sessions = [{ id: 'sess-1', cliType: 'claude-code' }];
    mockState.cliToolsCache = {};
  });

  it('wraps literal text in bracketed paste when enabled', async () => {
    mockGetTerminalManager.mockReturnValue({
      getSession: (id: string) => ({
        view: {
          isBracketedPasteEnabled: () => true,
          focus: vi.fn(),
          paste: vi.fn(),
        },
      }),
    });

    await deliverBulkText('sess-1', 'hello{Enter}');

    expect(mockPtyWrite).toHaveBeenCalledWith('sess-1', '\x1b[200~hello{Enter}\x1b[201~');
  });
});
