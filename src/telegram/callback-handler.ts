/**
 * Handles callback queries from Telegram inline keyboards.
 * Routes button presses to the appropriate action.
 *
 * Callback data format (defined by keyboards.ts):
 *   topic:{sessionId}   — Navigate to topic (legacy toast-only)
 *   topic_create:{sessionId} — Create the session's topic, then refresh the keyboard
 *   topic_cleanup:preview/confirm/cancel — Guarded stale topic cleanup
 *   reply:{sessionId}   — Return to session control panel from relay message
 *   continue:{sessionId} — Send Enter to session
 *   sessions:list       — Show directory list
 *   dir:{path}          — Drill into directory
 *   sess:{sessionId}    — Show session controls
 *   spawn:start / spawn:tool:{name} / spawn:project:{id} / spawn:dir:{pathIndex} — Spawn wizard
 *   cancel:{sessionId}  — Ctrl+C
 *   accept:{sessionId}  — Enter (accept)
 *   status:all          — Full status overview
 *   peek:{sessionId}    — Peek at session terminal output
 */

import type * as TelegramBot from 'node-telegram-bot-api';
import type { TelegramBotCore } from './bot.js';
import type { TopicManager } from './topic-manager.js';
import type { SessionManager } from '../session/manager.js';
import type { PtyManager } from '../session/pty-manager.js';
import type { ConfigLoader } from '../config/loader.js';
import type { ProjectStore } from '../session/project-store.js';
import {
  directoryListKeyboard,
  sessionListKeyboard,
  sessionControlKeyboard,
  spawnToolKeyboard,
  spawnDirKeyboard,
  spawnProjectKeyboard,
  resolvePathIndex,
} from './keyboards.js';
import { sendPeekOutput } from './command-handler.js';
import { deliverPromptSequenceToSession } from '../session/sequence-delivery.js';
import { escapeHtml } from './utils.js';
import { spawnConfiguredSession } from '../session/configured-session-spawn.js';
import { logger } from '../utils/logger.js';
import { normalizeProjectPath, dirDisplayNameFromPath } from '../session/project-identity.js';
import { cliLabel } from './cli-label.js';

/**
 * Register callback query handler on the bot.
 * Returns a dispose function that removes the listener.
 */
export function setupCallbackHandler(
  bot: TelegramBotCore,
  topicManager: TopicManager,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  configLoader: ConfigLoader,
  projectStore?: ProjectStore,
): () => void {
  const handler = async (query: TelegramBot.CallbackQuery) => {
    const data = query.data;
    if (!data) return;

    try {
      await routeCallback(
        data, query, bot, topicManager,
        sessionManager, ptyManager, configLoader,
        projectStore,
      );
    } catch (err) {
      logger.error(`[CallbackHandler] Error processing ${data}: ${err}`);
      await bot.answerCallback(query.id, '❌ Error processing action');
    }
  };

  bot.on('callback_query', handler);

  return () => {
    bot.removeListener('callback_query', handler);
  };
}

/**
 * Topic id of the message a callback came from, if it is still reachable.
 *
 * `query.message` is a MaybeInaccessibleMessage: Telegram substitutes a stub
 * carrying only chat/message_id/date once the original is too old, and that stub
 * has no topic. Falling back to undefined puts the reply in the chat's General
 * topic rather than throwing.
 */
function threadIdOf(msg: TelegramBot.MaybeInaccessibleMessage): number | undefined {
  return 'message_thread_id' in msg ? msg.message_thread_id : undefined;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

async function routeCallback(
  data: string,
  query: TelegramBot.CallbackQuery,
  bot: TelegramBotCore,
  topicManager: TopicManager,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  configLoader: ConfigLoader,
  projectStore?: ProjectStore,
): Promise<void> {
  const [action, ...rest] = data.split(':');
  const payload = rest.join(':');

  switch (action) {
    case 'sessions':
      await handleSessionsList(bot, sessionManager, query);
      break;
    case 'dir':
      await handleDirectoryDrill(bot, sessionManager, payload, query);
      break;
    case 'sess':
      await handleSessionSelect(bot, sessionManager, payload, query);
      break;
    case 'topic':
      await bot.answerCallback(query.id, '📌 Go to topic');
      break;
    case 'topic_create':
      await handleTopicCreate(bot, topicManager, sessionManager, payload, query);
      break;
    case 'topic_cleanup':
      await handleTopicCleanup(bot, topicManager, payload, query);
      break;
    case 'reply':
      await handleReply(bot, sessionManager, payload, query);
      break;
    case 'continue':
      await handleContinue(bot, ptyManager, payload, query);
      break;
    case 'cancel':
      await handleCancel(bot, ptyManager, payload, query);
      break;
    case 'accept':
      await handleAccept(bot, ptyManager, payload, query);
      break;
    case 'spawn':
      await handleSpawn(bot, topicManager, sessionManager, ptyManager, configLoader, projectStore, payload, query);
      break;
    case 'talk':
      await handleTalk(bot, topicManager, sessionManager, ptyManager, configLoader, payload, query);
      break;
    case 'status':
      await handleStatus(bot, sessionManager, query);
      break;
    case 'close_session':
      await handleCloseSession(bot, sessionManager, ptyManager, payload, query);
      break;
    case 'closeall':
      await handleCloseAll(bot, sessionManager, ptyManager, query);
      break;
    case 'peek':
      await handlePeek(bot, sessionManager, ptyManager, payload, query);
      break;
    default:
      logger.warn(`[CallbackHandler] Unknown callback: ${data}`);
      await bot.answerCallback(query.id, '❓ Unknown action');
  }
}

// ---------------------------------------------------------------------------
// Session navigation
// ---------------------------------------------------------------------------

async function handleSessionsList(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const sessions = sessionManager.getAllSessions();
  const { text, keyboard } = directoryListKeyboard(sessions);

  await editOriginalMessage(bot, query, text, keyboard);
  await bot.answerCallback(query.id);
}

async function handleDirectoryDrill(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  pathIndex: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const directory = resolvePathIndex(pathIndex);
  if (!directory) {
    await bot.answerCallback(query.id, '❌ Directory not found');
    return;
  }

  const all = sessionManager.getAllSessions();
  const normalizedDirectory = normalizeProjectPath(directory);
  const dirSessions = all.filter(s => s.workingDir && normalizeProjectPath(s.workingDir) === normalizedDirectory);
  const { text, keyboard } = sessionListKeyboard(dirSessions, directory);

  await editOriginalMessage(bot, query, text, keyboard);
  await bot.answerCallback(query.id);
}

async function handleSessionSelect(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    await bot.answerCallback(query.id, '❌ Session not found');
    return;
  }

  const { text, keyboard } = sessionControlKeyboard(session, bot.getChatId());

  await editOriginalMessage(bot, query, text, keyboard);
  await bot.answerCallback(query.id);
}

// ---------------------------------------------------------------------------
// Session actions
// ---------------------------------------------------------------------------

/**
 * Handle reply button from relay messages.
 * Navigates back to the session control view where users can interact with the session.
 */
async function handleReply(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    await bot.answerCallback(query.id, '❌ Session not found');
    return;
  }

  const { text, keyboard } = sessionControlKeyboard(session, bot.getChatId());

  await editOriginalMessage(bot, query, text, keyboard);
  await bot.answerCallback(query.id, '📝 Reply to session');
}

/**
 * Create the forum topic for a session, then re-render the same control
 * keyboard so the topic button flips from "Create Topic" (callback) to
 * "Go to Topic" (url) and the user can tap it again to navigate.
 */
async function handleTopicCreate(
  bot: TelegramBotCore,
  topicManager: TopicManager,
  sessionManager: SessionManager,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    await bot.answerCallback(query.id, '❌ Session not found');
    return;
  }

  const topicId = await topicManager.ensureTopic(session);
  if (topicId == null) {
    await bot.answerCallback(query.id, '❌ Failed to create topic');
    return;
  }

  const refreshed = sessionManager.getSession(sessionId) ?? session;
  const { text, keyboard } = sessionControlKeyboard(refreshed, bot.getChatId());
  await editOriginalMessage(bot, query, text, keyboard);
  await bot.answerCallback(query.id, '📌 Topic ready — tap Go to Topic');
}

async function handleTopicCleanup(
  bot: TelegramBotCore,
  topicManager: TopicManager,
  payload: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  if (payload === 'cancel') {
    await bot.answerCallback(query.id, 'Cleanup cancelled');
    await editOriginalMessage(bot, query, 'Topic cleanup cancelled.', [
      [{ text: '📂 Sessions', callback_data: 'sessions:list' }],
    ]);
    return;
  }

  if (payload === 'confirm') {
    const result = await topicManager.cleanupStaleTopics();
    await editOriginalMessage(bot, query, formatTopicCleanupResult(result), [
      [{ text: '📂 Sessions', callback_data: 'sessions:list' }],
    ]);
    await bot.answerCallback(query.id, 'Cleanup complete');
    return;
  }

  const preview = await topicManager.previewStaleTopics();
  await editOriginalMessage(bot, query, formatTopicCleanupPreview(preview), [
    [
      { text: '✅ Confirm', callback_data: 'topic_cleanup:confirm' },
      { text: '✋ Cancel', callback_data: 'topic_cleanup:cancel' },
    ],
  ]);
  await bot.answerCallback(query.id, 'Preview ready');
}

async function handleContinue(
  bot: TelegramBotCore,
  ptyManager: PtyManager,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  ptyManager.write(sessionId, '\r');
  await bot.answerCallback(query.id, '🚀 Sent continue (Enter)');
}

function formatTopicCleanupPreview(
  preview: Awaited<ReturnType<TopicManager['previewStaleTopics']>>,
): string {
  const lines = [
    '🧹 Topic Cleanup Preview',
    '',
    'Telegram cannot list every forum topic.',
    'Cleanup is limited to Helm-known mappings.',
    '',
    `Sessions checked: ${preview.totalSessions}`,
    `Mapped topics: ${preview.mappedTopics}`,
    `Alive active topics: ${preview.alive}`,
    `Dead mappings to clear: ${preview.dead}`,
    `Orphan topics to delete: ${preview.probes.filter(probe => probe.status === 'orphan').length}`,
    `Probe failures: ${preview.failed}`,
  ];

  if (preview.dead > 0 || preview.probes.some(probe => probe.status === 'orphan')) {
    lines.push('', 'Confirm to clear dead mappings and delete orphans.');
    lines.push('Active session topics are skipped.');
  } else {
    lines.push('', 'Nothing destructive is pending.');
  }

  return lines.join('\n');
}

function formatTopicCleanupResult(
  result: Awaited<ReturnType<TopicManager['cleanupStaleTopics']>>,
): string {
  return [
    '🧹 Topic Cleanup Result',
    '',
    'Only Helm-known topic mappings were checked.',
    `Deleted topics: ${result.deleted}`,
    `Cleared dead mappings: ${result.cleared}`,
    `Skipped active topics: ${result.skipped}`,
    `Failures: ${result.failed}`,
  ].join('\n');
}

async function handleCancel(
  bot: TelegramBotCore,
  ptyManager: PtyManager,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  ptyManager.write(sessionId, '\x03');
  await bot.answerCallback(query.id, '✋ Sent cancel (Ctrl+C)');
}

async function handleAccept(
  bot: TelegramBotCore,
  ptyManager: PtyManager,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  ptyManager.write(sessionId, '\r');
  await bot.answerCallback(query.id, '✅ Sent accept (Enter)');
}

// ---------------------------------------------------------------------------
// Talk flow
// ---------------------------------------------------------------------------

async function handleTalk(
  bot: TelegramBotCore,
  topicManager: TopicManager,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  configLoader: ConfigLoader,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    await bot.answerCallback(query.id, 'Session not found');
    return;
  }

  await topicManager.ensureTopic(session);
  const nudge = 'User is now available in Telegram. Give them a brief update on what you are doing. Keep it short and mobile-friendly.';
  await deliverPromptSequenceToSession({
    sessionId: session.id,
    text: nudge,
    ptyManager,
    sessionManager,
    configLoader,
  });
  await bot.answerCallback(query.id, `Opening ${session.name}`);
}

// ---------------------------------------------------------------------------
// Spawn wizard
// ---------------------------------------------------------------------------

/** Tracks which tool a user selected in step 1 of the spawn wizard. TTL: 5 min. */
const spawnWizardState = new Map<number, { tool: string; createdAt: number }>();
const SPAWN_WIZARD_TTL_MS = 5 * 60 * 1000;

/**
 * Groups working directories by their Helm project record.
 * Dirs with no matching project are skipped.
 * Exported for unit testing.
 */

async function handleSpawn(
  bot: TelegramBotCore,
  topicManager: TopicManager,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  configLoader: ConfigLoader,
  projectStore: ProjectStore | undefined,
  payload: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  if (payload === 'start') {
    await handleSpawnToolSelect(bot, configLoader, query);
  } else if (payload.startsWith('tool:')) {
    await handleSpawnProjectSelect(bot, configLoader, projectStore, payload.substring(5), query);
  } else if (payload.startsWith('project:')) {
    await handleSpawnDirSelect(bot, topicManager, sessionManager, ptyManager, configLoader, projectStore, payload.substring(8), query);
  } else if (payload.startsWith('dir:')) {
    await handleSpawnExec(bot, topicManager, sessionManager, ptyManager, configLoader, payload.substring(4), query);
  }
}

async function handleSpawnToolSelect(
  bot: TelegramBotCore,
  configLoader: ConfigLoader,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const tools = configLoader.getCliTypes().map((id) => ({
    id,
    label: configLoader.getCliTypeName(id) ?? id,
  }));
  const keyboard = spawnToolKeyboard(tools);

  await editOriginalMessage(bot, query, '🛠️ Select a CLI tool:', keyboard);
  await bot.answerCallback(query.id);
}

/**
 * Step 2: store selected tool, then show project keyboard (or flat dir list if no projectStore).
 * Renamed from handleSpawnDirSelect — now shows projects as an intermediate step.
 */
async function handleSpawnProjectSelect(
  bot: TelegramBotCore,
  configLoader: ConfigLoader,
  projectStore: ProjectStore | undefined,
  toolName: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const resolved = configLoader.resolveCliType(toolName);
  if (!resolved) {
    await bot.answerCallback(query.id, `❌ Unknown CLI type: ${toolName}`);
    return;
  }
  // Store the canonical id — the wizard can outlive a rename.
  spawnWizardState.set(query.from.id, { tool: resolved.id, createdAt: Date.now() });
  const label = resolved.config.displayName ?? resolved.config.name;

  if (!projectStore) {
    await bot.answerCallback(query.id, '❌ Project store unavailable');
    return;
  }

  const projects = projectStore.list();
  const keyboard = spawnProjectKeyboard(projects);
  await editOriginalMessage(bot, query, `🗂️ Select project for ${label}:`, keyboard);
  await bot.answerCallback(query.id, `Selected: ${label}`);
}

/**
 * Step 3: project selected — auto-spawn if single dir, else show folder picker.
 * topicManager kept in signature for future use (topic creation is currently event-driven).
 */
async function handleSpawnDirSelect(
  bot: TelegramBotCore,
  _topicManager: TopicManager,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  configLoader: ConfigLoader,
  projectStore: ProjectStore | undefined,
  projectId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const userId = query.from.id;
  const entry = spawnWizardState.get(userId);

  if (!entry || Date.now() - entry.createdAt > SPAWN_WIZARD_TTL_MS) {
    await bot.answerCallback(query.id, '❌ Wizard expired. Start over with /spawn');
    return;
  }

  if (!projectStore) {
    await bot.answerCallback(query.id, '❌ Project store unavailable');
    return;
  }

  const project = projectStore.getById(projectId);
  if (!project) {
    await bot.answerCallback(query.id, '❌ Project not found. Start over with /spawn');
    return;
  }

  const allPaths = [project.canonicalPath, ...(project.alternatePaths ?? [])];
  const projectDirs = allPaths.map(p => ({ name: dirDisplayNameFromPath(p), path: p }));

  if (projectDirs.length === 1) {
    spawnWizardState.delete(userId);
    await doSpawnSession(bot, sessionManager, ptyManager, configLoader, entry.tool, projectDirs[0].path, query);
    return;
  }

  const keyboard = spawnDirKeyboard(projectDirs);
  const toolLabel = configLoader.resolveCliType(entry.tool)?.config.displayName ?? entry.tool;
  await editOriginalMessage(bot, query, `📂 Select folder for ${toolLabel}:`, keyboard);
  await bot.answerCallback(query.id);
}

/** Core spawn logic — shared by handleSpawnExec (dir picked) and handleSpawnDirSelect (auto-spawn). */
async function doSpawnSession(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  configLoader: ConfigLoader,
  cliType: string,
  dirPath: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  try {
    configLoader.reloadActiveProfileIfChanged();
    // The wizard callback carries whatever handle the button was built with;
    // resolve it so the session records the uuid and the user sees the label.
    const cli = configLoader.resolveCliType(cliType);
    if (!cli) {
      await bot.answerCallback(query.id, `❌ Unknown CLI type: ${cliType}`);
      return;
    }
    const label = cli.config.displayName ?? cli.config.name;
    const spawnConfig = configLoader.getSpawnConfig(cli.id);
    const { sessionId } = spawnConfiguredSession({
      ptyManager,
      sessionManager,
      configLoader,
      cliType: cli.id,
      sessionName: label,
      ...(spawnConfig?.command ? { command: spawnConfig.command, args: spawnConfig.args ?? [] } : {}),
      cwd: dirPath,
      fallbackCompleteDelayMs: 500,
    });

    await bot.answerCallback(query.id, `🚀 Spawned ${label}!`);

    const msg = query.message;
    if (msg) {
      await bot.getBot()?.sendMessage(
        msg.chat.id,
        `✅ Spawned <b>${escapeHtml(label)}</b> in <code>${escapeHtml(dirPath)}</code>\nSession: ${sessionId.substring(0, 8)}…`,
        { parse_mode: 'HTML', message_thread_id: threadIdOf(msg) },
      );
    }
    logger.info(`[SpawnWizard] Spawned ${label} (${cli.id}) in ${dirPath} → session ${sessionId}`);
  } catch (err) {
    logger.error(`[SpawnWizard] Spawn failed: ${err}`);
    await bot.answerCallback(query.id, '❌ Spawn failed');
  }
}

/** Step 4 (final): dir was explicitly chosen from the folder keyboard — spawn the session. */
async function handleSpawnExec(
  bot: TelegramBotCore,
  _topicManager: TopicManager,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  configLoader: ConfigLoader,
  pathIndex: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const userId = query.from.id;
  const entry = spawnWizardState.get(userId);
  spawnWizardState.delete(userId);

  if (!entry || Date.now() - entry.createdAt > SPAWN_WIZARD_TTL_MS) {
    await bot.answerCallback(query.id, '❌ No tool selected or wizard expired. Start over with /spawn');
    return;
  }

  const dirPath = resolvePathIndex(pathIndex);
  if (!dirPath) {
    await bot.answerCallback(query.id, '❌ Directory not found. Start over with /spawn');
    return;
  }

  await doSpawnSession(bot, sessionManager, ptyManager, configLoader, entry.tool, dirPath, query);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function handleStatus(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const sessions = sessionManager.getAllSessions();

  if (sessions.length === 0) {
    await bot.answerCallback(query.id, 'No active sessions');
    return;
  }

  const stateEmojis: Record<string, string> = {
    implementing: '🔨', planning: '📐', completed: '🎉', waiting: '⏳', idle: '💤',
  };

  let text = '📊 <b>Session Status</b>\n\n';
  for (const s of sessions) {
    const state = s.state ?? 'idle';
    text += `${stateEmojis[state] ?? '⚪'} <b>${escapeHtml(s.name)}</b> (${escapeHtml(cliLabel(s.cliType))})\n`;
    text += `   ${state}\n\n`;
  }

  const msg = query.message;
  if (msg) {
    await bot.getBot()?.sendMessage(msg.chat.id, text, {
      parse_mode: 'HTML',
      message_thread_id: threadIdOf(msg),
    });
  }
  await bot.answerCallback(query.id);
}

// ---------------------------------------------------------------------------
// Close Session (single, topic-scoped)
// ---------------------------------------------------------------------------

async function handleCloseSession(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    await bot.answerCallback(query.id, '❌ Session not found');
    return;
  }
  if (session.locked) {
    await bot.answerCallback(query.id, `🔒 ${session.name} is locked`);
    return;
  }
  await bot.answerCallback(query.id, `🔴 Closing ${session.name}…`);
  ptyManager.kill(sessionId);
  if (sessionManager.hasSession(sessionId)) {
    sessionManager.removeSession(sessionId);
  }
}

// ---------------------------------------------------------------------------
// Close All
// ---------------------------------------------------------------------------

async function handleCloseAll(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const sessions = sessionManager.getAllSessions();
  if (sessions.length === 0) {
    await bot.answerCallback(query.id, 'No sessions to close');
    return;
  }

  let closed = 0;
  let locked = 0;
  for (const session of sessions) {
    if (session.locked) { locked++; continue; }
    try {
      ptyManager.kill(session.id);
      // removeSession triggers session:removed → topic cleanup + notifier/mirror/summarizer cleanup
      if (sessionManager.hasSession(session.id)) {
        sessionManager.removeSession(session.id);
      }
      closed++;
    } catch (err) {
      logger.error(`[CloseAll] Failed to close session ${session.id}: ${err}`);
    }
  }

  await bot.answerCallback(query.id, `🗑️ Closed ${closed} session(s)${locked ? `; ${locked} locked` : ''}`);
}

// ---------------------------------------------------------------------------
// Peek
// ---------------------------------------------------------------------------

async function handlePeek(
  bot: TelegramBotCore,
  sessionManager: SessionManager,
  ptyManager: PtyManager,
  sessionId: string,
  query: TelegramBot.CallbackQuery,
): Promise<void> {
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    await bot.answerCallback(query.id, '❌ Session not found');
    return;
  }

  await bot.answerCallback(query.id);

  const msg = query.message;
  if (msg) {
    await sendPeekOutput(bot, ptyManager, msg, { id: session.id, name: session.name });
  }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/** Edit the message that contained the inline keyboard the user tapped. */
async function editOriginalMessage(
  bot: TelegramBotCore,
  query: TelegramBot.CallbackQuery,
  text: string,
  keyboard: TelegramBot.InlineKeyboardButton[][],
): Promise<void> {
  const msg = query.message;
  if (!msg) return;

  try {
    await bot.getBot()?.editMessageText(text, {
      chat_id: msg.chat.id,
      message_id: msg.message_id,
      reply_markup: { inline_keyboard: keyboard },
    });
  } catch (err) {
    const errStr = String(err);
    if (!errStr.includes('message is not modified')) {
      logger.error(`[CallbackHandler] editOriginalMessage failed: ${err}`);
    }
  }
}


