/**
 * useRuntimeGroupActions — centralizes the runtime-group UI actions that the
 * sidebar (split button, group headers, session cards, context menu) invoke.
 *
 * Wraps the thin useRuntimeGroups() client with the modal flows:
 *  - promptCreate   → opens the name modal, creates a group, optionally moves a
 *                     session into it (drop-onto-New-Group / "New group…").
 *  - promptRename   → opens the name modal prefilled, renames on submit.
 *  - requestClose   → empty group closes silently; a group WITH members opens the
 *                     3-way close dialog.
 *
 * The close-all path deliberately reuses the SAME session-close code path the app
 * uses everywhere (doCloseSession → sessionsClient.sessionClose), so main's
 * session:removed listener still tags each recycle-bin entry with the group while
 * membership is intact. Ordering is decided by buildCloseGroupPlan: close member
 * sessions FIRST, then remove the group.
 */
import { useRuntimeGroups } from './useRuntimeGroups.js';
import { openRuntimeGroupNameModal, openRuntimeGroupCloseModal } from '../stores/modal-bridge.js';
import { buildCloseGroupPlan } from '../close-group-plan.js';
import { doCloseSession } from '../composables/useAppBootstrap.js';
import type { RuntimeGroup } from '../../src/types/runtime-group.js';

export function useRuntimeGroupActions() {
  const rg = useRuntimeGroups();

  /** Group a session currently belongs to, or null. */
  function groupOfSession(sessionId: string): RuntimeGroup | null {
    return rg.groups.value.find(g => g.sessionIds.includes(sessionId)) ?? null;
  }

  /** Open the name modal to create a group; optionally move a session into it. */
  function promptCreate(moveSessionId?: string): void {
    openRuntimeGroupNameModal('create', async (name) => {
      await rg.create(name);
      if (moveSessionId) {
        // create() has refreshed the list; the newest group is the one we made.
        const created = [...rg.groups.value].sort((a, b) => b.createdAt - a.createdAt)[0];
        if (created) await rg.addSession(created.id, moveSessionId);
      }
    });
  }

  /** Open the name modal prefilled to rename an existing group. */
  function promptRename(group: { id: string; name: string; color?: string }): void {
    openRuntimeGroupNameModal('rename', async (name, color) => {
      await rg.rename(group.id, name);
      if (color && color !== group.color) await rg.setColor(group.id, color);
    }, group.name, group.color);
  }

  /** Add a session to a group (auto-evicts from any prior group in main). */
  async function moveToGroup(groupId: string, sessionId: string): Promise<void> {
    await rg.addSession(groupId, sessionId);
  }

  /** Remove a session from its runtime group (reverts to directory grouping). */
  async function removeFromGroup(sessionId: string): Promise<void> {
    await rg.removeSession(sessionId);
  }

  /**
   * Close a runtime group. Empty groups close immediately; groups with members
   * open the 3-way dialog and resolve through executeClosePlan.
   */
  function requestClose(group: { id: string; name: string; sessionIds: string[] }): void {
    const members = group.sessionIds;
    if (members.length === 0) {
      void rg.closeGroup(group.id);
      return;
    }
    openRuntimeGroupCloseModal(group.id, group.name, members.length, (mode) => {
      void executeClosePlan(group.id, members, mode);
    });
  }

  /**
   * Execute the ordered close plan. Sessions are closed FIRST (through the shared
   * session-close path, so recycle-bin tagging fires), then the group is removed.
   *
   * If any member fails to close, ABORT before removing the group: leaving the
   * group intact keeps the still-running session grouped (and therefore taggable
   * if it is closed later) rather than orphaning it.
   */
  async function executeClosePlan(
    groupId: string,
    memberIds: string[],
    mode: 'keep' | 'closeAll',
  ): Promise<void> {
    const plan = buildCloseGroupPlan(mode, memberIds.map(id => ({ id })));
    for (const sessionId of plan.closeSessionIds) {
      const closed = await doCloseSession(sessionId);
      if (!closed) return;
    }
    if (plan.closeGroup) {
      await rg.closeGroup(groupId);
    }
  }

  return {
    groups: rg.groups,
    groupOfSession,
    promptCreate,
    promptRename,
    moveToGroup,
    removeFromGroup,
    requestClose,
  };
}
