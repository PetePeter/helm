/**
 * usePromptApplyFlow — the single prompt-template apply path, shared by the
 * main window and the snap-out (popout) window.
 *
 * Flow: open the picker tree → on pick, open the Prompt Editor PREFILLED with
 * the template body, that node selected in the left tree, caret at the END.
 * The user amends and Ctrl+Enter sends via deliverPromptSequence (sequence
 * syntax honored). Picking NEVER sends directly.
 */
import { showPromptTree, getPromptTreeCallback, hidePromptTree } from '../stores/modal-bridge.js';
import { showEditorPopup } from '../editor/editor-popup.js';
import { promptTemplatesClient } from '../ipc/clients.js';
import { deliverPromptSequence } from '../sequence-delivery.js';
import type { PromptTemplate } from '../../src/session/prompt-template-types.js';

export function usePromptApplyFlow(getSessionId: () => string | null | undefined) {
  /** Entry point for context menu / gamepad — open the picker tree. */
  async function openPromptPicker(sessionId = getSessionId()): Promise<void> {
    await showPromptTree((templateId) => { void openEditorForTemplate(templateId, sessionId); });
  }

  /** Open the editor prefilled with the picked template's body. */
  async function openEditorForTemplate(templateId: string, sessionId = getSessionId()): Promise<void> {
    let body = '';
    try {
      const node = await promptTemplatesClient.promptTemplateGetNode(templateId);
      body = (node as PromptTemplate | null)?.body ?? '';
    } catch {
      // IPC failed — open the editor empty rather than aborting the flow.
    }
    // hasPrefill=true: the body is an explicit prefill and must override any
    // saved ctrl-g draft, even when the template body (or failed lookup) is ''.
    await showEditorPopup((text) => {
      if (sessionId) void deliverPromptSequence(sessionId, text);
    }, body, templateId, true);
  }

  /**
   * Bridge handler for PromptTreeModal @select — fires the onSelect registered
   * by showPromptTree(). Capture the callback BEFORE hiding, since hidePromptTree()
   * clears it.
   */
  function handlePromptTreeSelect(templateId: string): void {
    const cb = getPromptTreeCallback();
    hidePromptTree();
    cb?.(templateId);
  }

  return { openPromptPicker, openEditorForTemplate, handlePromptTreeSelect };
}
