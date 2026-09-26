/**
 * Config-driven binding dispatch.
 *
 * Resolves CLI-specific bindings for the active session.
 */

import { state } from './state.js';
import { logEvent } from './utils.js';
import { parseSequence, formatSequencePreview } from '../src/input/sequence-parser.js';
import { executeSequenceString, keyToPtySequence, comboToPtySequence } from '../src/input/sequence-executor.js';
import type { Binding } from '../src/config/loader.js';
import { getTerminalManager } from './runtime/terminal-provider.js';
import { deliverBulkText } from './paste-handler.js';
import { showDraftEditor } from './stores/draft-editor-registry.js';
import { configClient, keyboardClient, terminalClient, toolsClient } from './ipc/clients.js';
import { createVoiceTalkHolds } from './voice/voice-talk-binding.js';
import { useVoiceCall } from './composables/useVoiceCall.js';

function executeScroll(binding: { direction: string; lines?: number }): void {
  const overviewGrid = document.getElementById('overviewGrid');
  if (overviewGrid && overviewGrid.style.display !== 'none') {
    const lineHeight = 18;
    const amount = (binding.lines ?? 5) * lineHeight;
    overviewGrid.scrollBy({ top: binding.direction === 'up' ? -amount : amount, behavior: 'smooth' });
    logEvent(`Scroll overview: ${binding.direction}`);
    return;
  }

  const tm = getTerminalManager();
  const activeId = tm?.getActiveSessionId();
  if (activeId) {
    const session = tm?.getSession(activeId);
    if (session) {
      const dir = binding.direction === 'up' ? 'up' as const : 'down' as const;
      session.view.scroll(dir, binding.lines ?? 5);
    }
  }
  logEvent(`Scroll: ${binding.direction}`);
}

const heldKeys = new Map<string, string[]>();
const ptyRoutedHolds = new Set<string>();
const voiceTalkHolds = createVoiceTalkHolds({
  startTalk: () => useVoiceCall().startTalk(),
  stopTalk: () => useVoiceCall().stopTalk(),
});

/**
 * End a held `voice-talk`. Called ahead of any focus gating: a talk started on
 * the terminal must still send when the button is released elsewhere.
 */
export function releaseVoiceTalk(button: string): boolean {
  return voiceTalkHolds.release(button);
}

export function keyToPtyEscape(key: string): string {
  return keyToPtySequence(key) ?? key;
}

export function comboToPtyEscape(keys: string[]): string {
  return comboToPtySequence(keys) ?? keys.join('');
}

export async function initConfigCache(): Promise<void> {
  try {
    for (const cliType of state.cliTypes) {
      const bindings = await configClient.configGetBindings(cliType);
      if (bindings) state.cliBindingsCache[cliType] = bindings;
    }

    try {
      const tools = await toolsClient.toolsGetAll();
      state.cliToolsCache = tools?.cliTypes ?? {};
    } catch (err) {
      console.warn('[Renderer] Failed to cache tools:', err);
    }

    console.log('[Renderer] Cached CLI bindings for:', Object.keys(state.cliBindingsCache));
  } catch (error) {
    console.error('[Renderer] Failed to init config cache:', error);
  }
}

export function processConfigBinding(button: string): void {
  if (state.activeSessionId) {
    const activeSession = state.sessions.find(s => s.id === state.activeSessionId);
    if (activeSession) {
      const cliBindings = state.cliBindingsCache[activeSession.cliType];
      const cliBinding = cliBindings?.[button];
      if (cliBinding) executeCliBinding(button, cliBinding);
    }
  }
}

export function processConfigRelease(button: string): void {
  if (ptyRoutedHolds.has(button)) {
    ptyRoutedHolds.delete(button);
    heldKeys.delete(button);
    return;
  }
  const keys = heldKeys.get(button);
  if (keys) {
    keyboardClient.keyboardComboUp(keys);
    heldKeys.delete(button);
  }
}

export function releaseAllHeldKeys(): void {
  voiceTalkHolds.releaseAll();
  for (const [button, keys] of heldKeys) {
    if (!ptyRoutedHolds.has(button)) keyboardClient.keyboardComboUp(keys);
  }
  heldKeys.clear();
  ptyRoutedHolds.clear();
}

async function executeCliBinding(button: string, binding: Binding): Promise<void> {
  try {
    switch (binding.action) {
      case 'keyboard': {
        if (!binding.sequence || typeof binding.sequence !== 'string') {
          console.warn(`[Renderer] Keyboard binding for ${button} missing sequence`);
          break;
        }
        await executeSequence(binding.sequence);
        break;
      }
      case 'voice': {
        if (!binding.key) {
          console.warn(`[Renderer] Voice binding for ${button} missing key`);
          break;
        }
        const keys = binding.key.split('+').map((k: string) => k.trim()).filter(Boolean);
        if (keys.length === 0) break;

        const tm = getTerminalManager();
        const activeId = tm?.getActiveSessionId();
        const usePty = activeId && binding.target === 'terminal' && terminalClient.ptyWrite;

        if (binding.mode === 'hold') {
          if (usePty) {
            const esc = keys.length === 1 ? keyToPtyEscape(keys[0]) : comboToPtyEscape(keys);
            await terminalClient.ptyWrite(activeId!, esc);
            ptyRoutedHolds.add(button);
            heldKeys.set(button, keys);
            logEvent(`Voice hold→PTY: ${binding.key}`);
          } else {
            await keyboardClient.keyboardComboDown(keys);
            heldKeys.set(button, keys);
            logEvent(`Voice hold→OS: ${binding.key}`);
          }
        } else {
          if (usePty) {
            const esc = keys.length === 1 ? keyToPtyEscape(keys[0]) : comboToPtyEscape(keys);
            await terminalClient.ptyWrite(activeId!, esc);
            logEvent(`Voice tap→PTY: ${binding.key}`);
          } else {
            if (keys.length === 1) await keyboardClient.keyboardKeyTap(keys[0]);
            else await keyboardClient.keyboardSendKeyCombo(keys);
            logEvent(`Voice tap→OS: ${binding.key}`);
          }
        }
        break;
      }
      case 'voice-talk':
        voiceTalkHolds.press(button);
        break;
      case 'scroll':
        executeScroll(binding);
        break;
      case 'context-menu': {
        const { showContextMenu } = await import('./stores/modal-bridge.js');
        const tm = getTerminalManager();
        if (tm) showContextMenu(state.activeSessionId || '');
        break;
      }
      case 'prompt-tree': {
        // PT-7: renamed from 'sequence-list'; opens the prompt-template picker tree (apply flow).
        const { usePromptApplyFlow } = await import('./composables/usePromptApplyFlow.js');
        const { openPromptPicker } = usePromptApplyFlow(() => state.activeSessionId);
        await openPromptPicker();
        break;
      }
      case 'new-draft':
        if (state.activeSessionId) {
          showDraftEditor(state.activeSessionId);
          logEvent('New draft from binding');
        }
        break;
      default:
        console.warn(`[Renderer] Unknown CLI action: ${binding.action}`);
    }
  } catch (error) {
    console.error(`[Renderer] CLI binding failed for ${button}:`, error);
  }
}

export async function executeSequenceForSession(sessionId: string, input: string): Promise<void> {
  if (!terminalClient.ptyWrite) {
    console.warn('[Renderer] executeSequenceForSession — ptyWrite not available');
    return;
  }

  const actions = parseSequence(input);
  logEvent(`Seq[${sessionId.slice(0, 8)}]: ${formatSequencePreview(actions)}`);

  await executeSequenceString({
    sessionId,
    input,
    write: (sid, data) => terminalClient.ptyWrite(sid, data),
    deliverText: (sid, text) => deliverBulkText(sid, text),
  });
}

export async function executeSequence(input: string): Promise<void> {
  const tm = getTerminalManager();
  const activeId = tm?.getActiveSessionId();
  if (!activeId || !terminalClient.ptyWrite) {
    console.warn('[Renderer] executeSequence — no active terminal');
    return;
  }
  await executeSequenceForSession(activeId, input);
}
