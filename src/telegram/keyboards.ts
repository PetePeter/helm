import type * as TelegramBot from 'node-telegram-bot-api';
import type { SessionInfo, SessionState } from '../types/session.js';
import path from 'path';
import { cliLabel } from './cli-label.js';

// Max button label length before truncation
const MAX_LABEL = 15;

/**
 * Telegram limits callback_data to 64 bytes.
 * Directory paths can easily exceed this, so we map them to short indices.
 * The registry is shared between keyboard builders and callback handlers.
 */
const pathRegistry = new Map<string, string>(); // index → path
const pathToIndex = new Map<string, string>();   // path → index
let pathCounter = 0;

/** Register a path and return its short index key. */
function registerPath(fullPath: string): string {
  const existing = pathToIndex.get(fullPath);
  if (existing) return existing;
  const key = String(pathCounter++);
  pathRegistry.set(key, fullPath);
  pathToIndex.set(fullPath, key);
  return key;
}

/** Resolve a short index key back to a full path. */
export function resolvePathIndex(key: string): string | undefined {
  return pathRegistry.get(key);
}

/** Reset the path registry (for tests only). */
export function _resetPathRegistry(): void {
  pathRegistry.clear();
  pathToIndex.clear();
  pathCounter = 0;
}

function truncLabel(text: string): string {
  return text.length > MAX_LABEL ? text.substring(0, MAX_LABEL - 1) + '…' : text;
}

// State emoji mapping
const STATE_EMOJI: Record<string, string> = {
  implementing: '🔨',
  planning: '📐',
  completed: '🎉',
  waiting: '⏳',
  idle: '💤',
};

function stateEmoji(state?: SessionState): string {
  return STATE_EMOJI[state ?? 'idle'] ?? '⚪';
}

/** Action buttons for a turn-ended notification. */
export function notificationKeyboard(sessionId: string): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [[
    { text: '📌 Go to Topic', callback_data: `topic:${sessionId}` },
    { text: '🚀 Continue', callback_data: `continue:${sessionId}` },
  ]];

  rows.push([
    { text: '📂 Sessions', callback_data: 'sessions:list' },
  ]);

  return rows;
}

/**
 * Group sessions by working directory and return directory-level overview keyboard.
 * Level 1 of the two-tier session navigation.
 */
export function directoryListKeyboard(
  sessions: SessionInfo[],
): { text: string; keyboard: TelegramBot.InlineKeyboardButton[][] } {
  // Group by workingDir
  const groups = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const dir = s.workingDir ?? 'unknown';
    const list = groups.get(dir) ?? [];
    list.push(s);
    groups.set(dir, list);
  }

  let text = `📂 Your Sessions (${sessions.length} active)\n\n`;
  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  const row: TelegramBot.InlineKeyboardButton[] = [];

  for (const [dir, dirSessions] of groups) {
    const dirName = path.basename(dir);
    const stateCounts = countStates(dirSessions);
    const bestEmoji = bestStateEmoji(dirSessions);

    text += `${bestEmoji} ${dirName} (${dirSessions.length})\n`;
    text += `   ${stateCounts}\n`;

    row.push({
      text: truncLabel(dirName),
      callback_data: `dir:${registerPath(dir)}`,
    });

    // Max 3 buttons per row
    if (row.length >= 3) {
      buttons.push([...row]);
      row.length = 0;
    }
  }

  if (row.length > 0) buttons.push([...row]);

  // Bottom row: New + Status
  buttons.push([
    { text: '➕ New', callback_data: 'spawn:start' },
    { text: '📊 Status', callback_data: 'status:all' },
  ]);

  return { text, keyboard: buttons };
}

/**
 * Show sessions within a specific directory.
 * Level 2 of the two-tier session navigation.
 */
export function sessionListKeyboard(
  sessions: SessionInfo[],
  directory: string,
): { text: string; keyboard: TelegramBot.InlineKeyboardButton[][] } {
  const dirName = path.basename(directory);
  let text = `📂 ${dirName}\n\n`;

  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  const row: TelegramBot.InlineKeyboardButton[] = [];

  for (const s of sessions) {
    const emoji = stateEmoji(s.state);
    text += `${emoji} "${s.name}" — ${cliLabel(s.cliType)}\n`;

    row.push({
      text: `${emoji} ${truncLabel(s.name)}`,
      callback_data: `sess:${s.id}`,
    });

    if (row.length >= 2) {
      buttons.push([...row]);
      row.length = 0;
    }
  }

  if (row.length > 0) buttons.push([...row]);
  buttons.push([{ text: '🔙 Back', callback_data: 'sessions:list' }]);

  return { text, keyboard: buttons };
}

/**
 * Build the supergroup forum topic deep-link URL.
 * Telegram supergroups have chat IDs of the form -100XXXXXXXXXX; the public
 * t.me/c/{n}/{thread} form drops the -100 prefix.
 */
function buildTopicUrl(chatId: number, topicId: number): string {
  const stripped = String(chatId).replace(/^-100/, '');
  return `https://t.me/c/${stripped}/${topicId}`;
}

/**
 * Build the topic-row button for the session control keyboard.
 * - Topic exists + chatId known → url button (one-tap navigation)
 * - Otherwise → callback button that creates the topic on tap
 */
function topicButton(
  session: SessionInfo,
  chatId: number | null,
): TelegramBot.InlineKeyboardButton {
  if (session.topicId != null && chatId != null) {
    return { text: '📌 Go to Topic', url: buildTopicUrl(chatId, session.topicId) };
  }
  return { text: '📌 Create Topic', callback_data: `topic_create:${session.id}` };
}

/**
 * Build session control keyboard (context-aware based on state).
 *
 * @param chatId Supergroup chat id used to build the t.me/c URL when a topic
 *   exists. Pass `null` to force the create-topic fallback.
 */
export function sessionControlKeyboard(
  session: SessionInfo,
  chatId: number | null = null,
): { text: string; keyboard: TelegramBot.InlineKeyboardButton[][] } {
  const emoji = stateEmoji(session.state);
  const text = `${emoji} ${cliLabel(session.cliType)} — ${path.basename(session.workingDir ?? 'unknown')}\nSession: "${session.name}"  ${emoji} ${capitalize(session.state ?? 'idle')}`;

  const keyboard: TelegramBot.InlineKeyboardButton[][] = [];
  const state = session.state ?? 'idle';

  keyboard.push([topicButton(session, chatId)]);

  if (state === 'implementing' || state === 'planning') {
    keyboard.push([
      { text: '✋ Cancel', callback_data: `cancel:${session.id}` },
      { text: '✅ Accept', callback_data: `accept:${session.id}` },
    ]);
  } else {
    keyboard.push([
      { text: '🚀 Continue', callback_data: `continue:${session.id}` },
    ]);
  }

  keyboard.push([
    { text: '📺 Peek', callback_data: `peek:${session.id}` },
    { text: '🔙 Back', callback_data: 'sessions:list' },
  ]);

  return { text, keyboard };
}

/**
 * Build the spawn wizard step 1: tool selection keyboard.
 *
 * Buttons show the human label but carry the CLI type id — since ids became
 * UUIDs, using the id as the label would show the user a UUID.
 */
export function spawnToolKeyboard(
  tools: Array<{ id: string; label: string }>,
): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  const row: TelegramBot.InlineKeyboardButton[] = [];

  for (const tool of tools) {
    row.push({ text: truncLabel(tool.label), callback_data: `spawn:tool:${tool.id}` });
    if (row.length >= 3) {
      rows.push([...row]);
      row.length = 0;
    }
  }

  if (row.length > 0) rows.push([...row]);
  rows.push([{ text: '🔙 Cancel', callback_data: 'sessions:list' }]);

  return rows;
}

/**
 * Build the spawn wizard project selection keyboard.
 * Each button navigates to spawn:project:{id} to pick a folder within that project.
 */
export function spawnProjectKeyboard(
  projects: Array<{ id: string; name: string }>,
): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  const row: TelegramBot.InlineKeyboardButton[] = [];

  for (const project of projects) {
    row.push({ text: truncLabel(project.name), callback_data: `spawn:project:${project.id}` });
    if (row.length >= 3) {
      rows.push([...row]);
      row.length = 0;
    }
  }

  if (row.length > 0) rows.push([...row]);
  rows.push([{ text: '🔙 Back', callback_data: 'spawn:start' }]);
  return rows;
}

/** Build a Talk button for a session in the pinned dashboard. */
export function sessionTalkButton(session: SessionInfo): TelegramBot.InlineKeyboardButton {
  return { text: '💬 Talk', callback_data: `talk:${session.id}` };
}

/**
 * Build the spawn wizard step 2: directory selection keyboard.
 */
export function spawnDirKeyboard(
  directories: Array<{ name: string; path: string }>,
): TelegramBot.InlineKeyboardButton[][] {
  const rows: TelegramBot.InlineKeyboardButton[][] = [];
  const row: TelegramBot.InlineKeyboardButton[] = [];

  for (const dir of directories) {
    row.push({ text: truncLabel(dir.name), callback_data: `spawn:dir:${registerPath(dir.path)}` });
    if (row.length >= 3) {
      rows.push([...row]);
      row.length = 0;
    }
  }

  if (row.length > 0) rows.push([...row]);
  rows.push([{ text: '🔙 Back', callback_data: 'spawn:start' }]);

  return rows;
}

// Helpers

function countStates(sessions: SessionInfo[]): string {
  const counts: Record<string, number> = {};
  for (const s of sessions) {
    const state = s.state ?? 'idle';
    counts[state] = (counts[state] ?? 0) + 1;
  }
  return Object.entries(counts)
    .map(([state, count]) => `${STATE_EMOJI[state] ?? '⚪'} ${count} ${state}`)
    .join(', ');
}

function bestStateEmoji(sessions: SessionInfo[]): string {
  const priority: SessionState[] = ['implementing', 'planning', 'completed', 'waiting', 'idle'];
  for (const state of priority) {
    if (sessions.some(s => s.state === state)) return STATE_EMOJI[state];
  }
  return '⚪';
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * Build a session picker keyboard for the /peek command
 * when multiple sessions exist and no name was given.
 */
export function peekSessionPickerKeyboard(
  sessions: SessionInfo[],
  getLabel?: (s: SessionInfo) => string,
): { text: string; keyboard: TelegramBot.InlineKeyboardButton[][] } {
  let text = `📺 Peek at which session?\n\n`;
  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  const row: TelegramBot.InlineKeyboardButton[] = [];

  for (const s of sessions) {
    const emoji = stateEmoji(s.state);
    const label = getLabel ? getLabel(s) : s.name;
    text += `${emoji} ${label}\n`;

    row.push({
      text: `${emoji} ${label}`,
      callback_data: `peek:${s.id}`,
    });

    if (row.length >= 3) {
      buttons.push([...row]);
      row.length = 0;
    }
  }

  if (row.length > 0) buttons.push([...row]);

  return { text, keyboard: buttons };
}

/**
 * Build help command keyboard with quick access to main features.
 */
export function helpKeyboard(
  sessionManager?: { getAllSessions(): SessionInfo[] },
  closeSessionId?: string,
): { keyboard: TelegramBot.InlineKeyboardButton[][] } {
  const sessions = sessionManager?.getAllSessions() ?? [];
  const buttons: TelegramBot.InlineKeyboardButton[][] = [];

  // Quick access row
  buttons.push([
    { text: '📂 Sessions', callback_data: 'sessions:list' },
    { text: '➕ Spawn', callback_data: 'spawn:start' },
    { text: '📊 Status', callback_data: 'status:all' },
  ]);

  // Peek + Close All row (only if sessions exist)
  if (sessions.length > 0) {
    buttons.push([
      { text: '📺 Peek', callback_data: 'peek:sessions' },
      { text: '🗑️ Close All', callback_data: 'closeall' },
    ]);
  }

  // Close this session button (only when in a session topic)
  if (closeSessionId) {
    buttons.push([
      { text: '🔴 Close Session', callback_data: `close_session:${closeSessionId}` },
    ]);
  }

  buttons.push([
    { text: '🧹 Clean Topics', callback_data: 'topic_cleanup:preview' },
  ]);

  return { keyboard: buttons };
}

/**
 * Build persistent buttons for relay messages sent to topic channels.
 * Creates two buttons in one row:
 *   - "Go to Topic" (navigates to the topic via callback_data topic:{topicId})
 *   - "Reply" (for returning to reply in the session via callback_data reply:{sessionId})
 */
export function relayMessageKeyboard(
  sessionId: string,
  topicId: number,
): TelegramBot.InlineKeyboardButton[][] {
  return [
    [
      { text: '📌 Go to Topic', callback_data: `topic:${topicId}` },
      { text: '📝 Reply', callback_data: `reply:${sessionId}` },
    ],
  ];
}

/**
 * Sort sessions by state priority: implementing/planning first (active work),
 * then completed/waiting, then idle (least active).
 * Within each tier, maintain original order.
 */
function sortSessionsByState(sessions: SessionInfo[]): SessionInfo[] {
  const priority: Record<string, number> = {
    implementing: 0,
    planning: 0,
    completed: 1,
    waiting: 1,
    idle: 2,
  };

  return [...sessions].sort((a, b) => {
    const aPriority = priority[a.state ?? 'idle'] ?? 2;
    const bPriority = priority[b.state ?? 'idle'] ?? 2;
    return aPriority - bPriority;
  });
}

/**
 * Build dashboard keyboard with topic navigation buttons for relay workflows.
 * For each session, adds:
 *   - Talk button (for Telegram interaction)
 *   - Topic link button (if topicId is mapped for this session)
 *
 * Sessions are sorted by state: implementing/planning first, idle last.
 * Static action buttons appear at the bottom.
 */
export function buildDashboardKeyboardWithTopics(
  sessions: SessionInfo[],
  topicMap: Map<string, number>,
): TelegramBot.InlineKeyboardButton[][] {
  const buttons: TelegramBot.InlineKeyboardButton[][] = [];
  const sortedSessions = sortSessionsByState(sessions);

  // Add session controls: talk button + optional topic button
  for (const session of sortedSessions) {
    const topicId = topicMap.get(session.id);

    // Talk button always present (in its own row)
    buttons.push([
      { text: '💬 Talk', callback_data: `talk:${session.id}` },
    ]);

    // Topic button only if topic is mapped (in its own row)
    if (topicId != null) {
      buttons.push([
        { text: '📌 Go to Topic', callback_data: `topic:${topicId}` },
      ]);
    }
  }

  // Static action buttons at bottom: Sessions/Spawn/Status in one row
  buttons.push([
    { text: '📂 Sessions', callback_data: 'sessions:list' },
    { text: '➕ Spawn', callback_data: 'spawn:start' },
    { text: '📊 Status', callback_data: 'status:all' },
  ]);

  // Close All in its own row
  buttons.push([
    { text: '🗑️ Close All', callback_data: 'closeall' },
  ]);

  buttons.push([
    { text: '🧹 Clean Topics', callback_data: 'topic_cleanup:preview' },
  ]);

  return buttons;
}
