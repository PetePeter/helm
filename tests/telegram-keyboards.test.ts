/**
 * Telegram keyboard builder unit tests
 *
 * Tests: all keyboard builder functions, callback_data prefixes,
 * edge cases (empty lists), button content.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  notificationKeyboard,
  directoryListKeyboard,
  sessionListKeyboard,
  sessionControlKeyboard,
  spawnToolKeyboard,
  spawnDirKeyboard,
  helpKeyboard,
  buildDashboardKeyboardWithTopics,
  resolvePathIndex,
  _resetPathRegistry,
} from '../src/telegram/keyboards.js';
import { setCliLabelResolver } from '../src/telegram/cli-label.js';
import type { SessionInfo } from '../src/types/session.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: 'sess-1',
    name: 'my-session',
    cliType: 'claude-code',
    processId: 1234,
    workingDir: '/projects/app',
    state: 'idle',
    ...overrides,
  };
}

/** Flatten all buttons from a keyboard into a single array. */
function allButtons(keyboard: any[][]) {
  return keyboard.flat();
}

/** Get all callback_data values from a keyboard. */
function allCallbackData(keyboard: any[][]): string[] {
  return allButtons(keyboard)
    .map((b: any) => b.callback_data)
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('notificationKeyboard', () => {
  it('creates the turn-ended keyboard', () => {
    const kb = notificationKeyboard('sess-1');

    expect(kb.length).toBeGreaterThanOrEqual(2);
    const data = allCallbackData(kb);
    expect(data).toContain('topic:sess-1');
    expect(data).toContain('continue:sess-1');
    expect(data).toContain('sessions:list');
  });

  it('all callback_data values contain session id or known prefix', () => {
    const kb = notificationKeyboard('abc');
    const data = allCallbackData(kb);
    for (const d of data) {
      expect(d).toMatch(/^(topic:|continue:|sessions:)/);
    }
  });
});

describe('directoryListKeyboard', () => {
  beforeEach(() => _resetPathRegistry());

  it('groups sessions by working directory', () => {
    const sessions = [
      makeSession({ id: 's1', name: 'a', workingDir: '/projects/app' }),
      makeSession({ id: 's2', name: 'b', workingDir: '/projects/app' }),
      makeSession({ id: 's3', name: 'c', workingDir: '/projects/lib' }),
    ];

    const { text, keyboard } = directoryListKeyboard(sessions);

    expect(text).toContain('3 active');
    expect(text).toContain('app');
    expect(text).toContain('lib');

    // callback_data uses dir:<index> — resolve back to verify paths
    const dirButtons = allButtons(keyboard).filter((b: any) =>
      b.callback_data?.startsWith('dir:'),
    );
    const resolvedPaths = dirButtons.map((b: any) =>
      resolvePathIndex(b.callback_data.replace('dir:', '')),
    );
    expect(resolvedPaths).toContain('/projects/app');
    expect(resolvedPaths).toContain('/projects/lib');
  });

  it('includes New and Status buttons in bottom row', () => {
    const sessions = [makeSession()];
    const { keyboard } = directoryListKeyboard(sessions);

    const lastRow = keyboard[keyboard.length - 1];
    const data = lastRow.map((b: any) => b.callback_data);
    expect(data).toContain('spawn:start');
    expect(data).toContain('status:all');
  });

  it('handles empty session list', () => {
    const { text, keyboard } = directoryListKeyboard([]);

    expect(text).toContain('0 active');
    // Should still have the bottom row with New + Status
    const data = allCallbackData(keyboard);
    expect(data).toContain('spawn:start');
  });

  it('callback_data uses dir: prefix with index', () => {
    const sessions = [makeSession({ workingDir: '/test/dir' })];
    const { keyboard } = directoryListKeyboard(sessions);

    const dirButtons = allButtons(keyboard).filter((b: any) =>
      b.callback_data?.startsWith('dir:'),
    );
    expect(dirButtons.length).toBeGreaterThan(0);
    // Index-based callback_data resolves back to the original path
    const idx = dirButtons[0].callback_data.replace('dir:', '');
    expect(resolvePathIndex(idx)).toBe('/test/dir');
  });
});

describe('sessionListKeyboard', () => {
  it('creates buttons for each session in directory', () => {
    const sessions = [
      makeSession({ id: 's1', name: 'alpha', state: 'implementing' }),
      makeSession({ id: 's2', name: 'beta', state: 'idle' }),
    ];

    const { text, keyboard } = sessionListKeyboard(sessions, '/projects/app');

    expect(text).toContain('app');
    expect(text).toContain('alpha');
    expect(text).toContain('beta');

    const data = allCallbackData(keyboard);
    expect(data).toContain('sess:s1');
    expect(data).toContain('sess:s2');
  });

  it('includes back button', () => {
    const { keyboard } = sessionListKeyboard([makeSession()], '/projects/app');
    const lastRow = keyboard[keyboard.length - 1];
    expect(lastRow.some((b: any) => b.callback_data === 'sessions:list')).toBe(true);
  });

  it('handles empty session list', () => {
    const { text, keyboard } = sessionListKeyboard([], '/projects/app');
    expect(text).toContain('app');
    // Should still have back button
    const data = allCallbackData(keyboard);
    expect(data).toContain('sessions:list');
  });

  it('callback_data uses sess: prefix', () => {
    const sessions = [makeSession({ id: 'test-id' })];
    const { keyboard } = sessionListKeyboard(sessions, '/dir');

    const sessButtons = allButtons(keyboard).filter((b: any) =>
      b.callback_data?.startsWith('sess:'),
    );
    expect(sessButtons.length).toBe(1);
    expect(sessButtons[0].callback_data).toBe('sess:test-id');
  });
});

describe('sessionControlKeyboard', () => {
  it('includes expected buttons for active session', () => {
    const session = makeSession({ state: 'implementing' });
    const { text, keyboard } = sessionControlKeyboard(session);

    expect(text).toContain('my-session');
    const data = allCallbackData(keyboard);
    expect(data).toContain(`cancel:${session.id}`);
    expect(data).toContain(`accept:${session.id}`);
    expect(data).toContain('sessions:list');
    expect(data).not.toContain(`output:${session.id}`);
    expect(data).not.toContain(`commands:${session.id}`);
  });

  it('includes continue for completed session', () => {
    const session = makeSession({ state: 'completed' });
    const { keyboard } = sessionControlKeyboard(session);

    const data = allCallbackData(keyboard);
    expect(data).toContain(`continue:${session.id}`);
    expect(data).not.toContain(`prompt:${session.id}`);
  });

  it('includes continue for idle session', () => {
    const session = makeSession({ state: 'idle' });
    const { keyboard } = sessionControlKeyboard(session);

    const data = allCallbackData(keyboard);
    expect(data).toContain(`continue:${session.id}`);
    expect(data).not.toContain(`prompt:${session.id}`);
  });

  it('always includes back without stale output or command controls', () => {
    for (const state of ['implementing', 'completed', 'idle', 'waiting'] as const) {
      const session = makeSession({ state });
      const { keyboard } = sessionControlKeyboard(session);
      const data = allCallbackData(keyboard);

      expect(data).toContain('sessions:list');
      expect(data).not.toContain(`output:${session.id}`);
      expect(data).not.toContain(`commands:${session.id}`);
      expect(data).not.toContain(`prompt:${session.id}`);
    }
  });

  it('text includes state emoji and capitalized state', () => {
    const session = makeSession({ state: 'implementing' });
    const { text } = sessionControlKeyboard(session);

    expect(text).toContain('🔨');
    expect(text).toContain('Implementing');
  });

  describe('topic button', () => {
    const CHAT_ID = -1003706536310;

    it('renders Go-to-Topic url button when topicId and chatId are set', () => {
      const session = makeSession({ topicId: 42 });
      const { keyboard } = sessionControlKeyboard(session, CHAT_ID);

      const goButton = allButtons(keyboard).find(b => b.text === '📌 Go to Topic');
      expect(goButton).toBeDefined();
      expect(goButton.url).toBe('https://t.me/c/3706536310/42');
      expect(goButton.callback_data).toBeUndefined();
    });

    it('renders Create-Topic callback button when topicId is missing', () => {
      const session = makeSession({ topicId: undefined });
      const { keyboard } = sessionControlKeyboard(session, CHAT_ID);

      const createButton = allButtons(keyboard).find(b => b.text === '📌 Create Topic');
      expect(createButton).toBeDefined();
      expect(createButton.callback_data).toBe(`topic_create:${session.id}`);
      expect(createButton.url).toBeUndefined();
    });

    it('falls back to Create-Topic when chatId is null even if topicId is set', () => {
      const session = makeSession({ topicId: 42 });
      const { keyboard } = sessionControlKeyboard(session, null);

      const createButton = allButtons(keyboard).find(b => b.text === '📌 Create Topic');
      expect(createButton).toBeDefined();
      const goButton = allButtons(keyboard).find(b => b.text === '📌 Go to Topic');
      expect(goButton).toBeUndefined();
    });

    it('topic button sits in its own row, separate from Continue/Peek/Back', () => {
      const session = makeSession({ topicId: 42, state: 'completed' });
      const { keyboard } = sessionControlKeyboard(session, CHAT_ID);

      const topicRow = keyboard.find(row =>
        row.some(b => b.text === '📌 Go to Topic' || b.text === '📌 Create Topic'),
      );
      expect(topicRow).toBeDefined();
      expect(topicRow!.length).toBe(1);
      const rowData = topicRow!.map(b => b.callback_data ?? '').join(',');
      expect(rowData).not.toContain('continue');
      expect(rowData).not.toContain('peek');
      expect(rowData).not.toContain('sessions:list');
    });

    it('topic button is independent of session state', () => {
      for (const state of ['idle', 'planning', 'implementing', 'completed', 'waiting'] as const) {
        const session = makeSession({ topicId: 42, state });
        const { keyboard } = sessionControlKeyboard(session, CHAT_ID);

        const found = allButtons(keyboard).some(b => b.text === '📌 Go to Topic');
        expect(found, `state=${state} should still show topic button`).toBe(true);
      }
    });

    it('preserves existing Continue and Peek/Back rows', () => {
      const session = makeSession({ state: 'idle' });
      const { keyboard } = sessionControlKeyboard(session, CHAT_ID);

      const data = allCallbackData(keyboard);
      expect(data).toContain(`continue:${session.id}`);
      expect(data).toContain(`peek:${session.id}`);
      expect(data).toContain('sessions:list');
    });

    it('strips -100 prefix from supergroup chat ids when building url', () => {
      const session = makeSession({ topicId: 7 });
      const { keyboard } = sessionControlKeyboard(session, -1009999999999);

      const goButton = allButtons(keyboard).find(b => b.text === '📌 Go to Topic');
      expect(goButton.url).toBe('https://t.me/c/9999999999/7');
    });
  });
});

describe('spawnToolKeyboard', () => {
  it('creates tool selection buttons', () => {
    const tools = [
      { id: 'uuid-cc', label: 'Claude Code' },
      { id: 'uuid-cp', label: 'Copilot CLI' },
      { id: 'uuid-ai', label: 'Aider' },
    ];
    const kb = spawnToolKeyboard(tools);

    const data = allCallbackData(kb);
    expect(data).toContain('spawn:tool:uuid-cc');
    expect(data).toContain('spawn:tool:uuid-cp');
    expect(data).toContain('spawn:tool:uuid-ai');
  });

  it('labels buttons with the display name, never the id', () => {
    const kb = spawnToolKeyboard([{ id: '5f3c2b1a-0000-4000-8000-000000000001', label: 'Claude Code' }]);
    const button = allButtons(kb).find((b: any) => b.callback_data?.startsWith('spawn:tool:'));
    expect(button.text).toBe('Claude Code');
    expect(button.callback_data).toBe('spawn:tool:5f3c2b1a-0000-4000-8000-000000000001');
  });

  it('includes cancel/back button', () => {
    const kb = spawnToolKeyboard([{ id: 'uuid-cc', label: 'Claude Code' }]);
    const lastRow = kb[kb.length - 1];
    expect(lastRow.some((b: any) => b.callback_data === 'sessions:list')).toBe(true);
  });

  it('handles empty tool list', () => {
    const kb = spawnToolKeyboard([]);
    // Should at least have the cancel row
    expect(kb.length).toBeGreaterThanOrEqual(1);
    const data = allCallbackData(kb);
    expect(data).toContain('sessions:list');
  });

  it('callback_data uses spawn:tool: prefix', () => {
    const kb = spawnToolKeyboard([{ id: 'my-tool', label: 'My Tool' }]);
    const toolButtons = allButtons(kb).filter((b: any) =>
      b.callback_data?.startsWith('spawn:tool:'),
    );
    expect(toolButtons.length).toBe(1);
  });
});

describe('spawnDirKeyboard', () => {
  beforeEach(() => _resetPathRegistry());

  it('creates directory selection buttons', () => {
    const dirs = [
      { name: 'Projects', path: '/home/user/projects' },
      { name: 'Work', path: '/home/user/work' },
    ];
    const kb = spawnDirKeyboard(dirs);

    // callback_data uses spawn:dir:<index>; resolve indices back to paths
    const dirButtons = allButtons(kb).filter((b: any) =>
      b.callback_data?.startsWith('spawn:dir:'),
    );
    const resolvedPaths = dirButtons.map((b: any) =>
      resolvePathIndex(b.callback_data.replace('spawn:dir:', '')),
    );
    expect(resolvedPaths).toContain('/home/user/projects');
    expect(resolvedPaths).toContain('/home/user/work');
  });

  it('includes back button to spawn:start', () => {
    const kb = spawnDirKeyboard([{ name: 'Dir', path: '/dir' }]);
    const lastRow = kb[kb.length - 1];
    expect(lastRow.some((b: any) => b.callback_data === 'spawn:start')).toBe(true);
  });

  it('handles empty directory list', () => {
    const kb = spawnDirKeyboard([]);
    const data = allCallbackData(kb);
    expect(data).toContain('spawn:start');
  });

  it('callback_data uses spawn:dir: prefix', () => {
    const kb = spawnDirKeyboard([{ name: 'X', path: '/x' }]);
    const dirButtons = allButtons(kb).filter((b: any) =>
      b.callback_data?.startsWith('spawn:dir:'),
    );
    expect(dirButtons.length).toBe(1);
  });
});

describe('topic cleanup controls', () => {
  it('adds Clean Topics to the help keyboard', () => {
    const { keyboard } = helpKeyboard();
    const button = allButtons(keyboard).find((b: any) => b.callback_data === 'topic_cleanup:preview');

    expect(button).toBeDefined();
    expect(button.text).toContain('Clean Topics');
  });

  it('adds Clean Topics to the dashboard keyboard', () => {
    const keyboard = buildDashboardKeyboardWithTopics([], new Map());
    const button = allButtons(keyboard).find((b: any) => b.callback_data === 'topic_cleanup:preview');

    expect(button).toBeDefined();
    expect(button.text).toContain('Clean Topics');
  });

  it('keeps cleanup callback data within Telegram limits', () => {
    const { keyboard } = helpKeyboard();
    const data = allCallbackData(keyboard).filter(d => d.startsWith('topic_cleanup:'));

    expect(data).toContain('topic_cleanup:preview');
    for (const callbackData of data) {
      expect(Buffer.byteLength(callbackData, 'utf8')).toBeLessThanOrEqual(64);
    }
  });
});


// ---------------------------------------------------------------------------
// CLI label rendering
// ---------------------------------------------------------------------------

describe('CLI type labels in Telegram text', () => {
  const CLAUDE_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

  beforeEach(() => {
    _resetPathRegistry();
    setCliLabelResolver(ref => (ref === CLAUDE_ID ? 'Claude Code' : ref));
  });

  afterEach(() => setCliLabelResolver(null));

  it('renders the display name, never the uuid, in the session list', () => {
    const sessions = [makeSession({ cliType: CLAUDE_ID })];
    const { text } = sessionListKeyboard(sessions, '/projects/app');

    expect(text).toContain('Claude Code');
    expect(text).not.toContain(CLAUDE_ID);
  });

  it('renders the display name, never the uuid, in the session control panel', () => {
    const { text } = sessionControlKeyboard(makeSession({ cliType: CLAUDE_ID }));

    expect(text).toContain('Claude Code');
    expect(text).not.toContain(CLAUDE_ID);
  });

  it('falls back to the raw reference when no resolver is wired', () => {
    setCliLabelResolver(null);
    const { text } = sessionControlKeyboard(makeSession({ cliType: 'generic-terminal' }));

    expect(text).toContain('generic-terminal');
  });
});
