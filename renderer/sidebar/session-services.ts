/**
 * Sidebar session services: sort preferences, rename flow, and status counts.
 *
 * Vue owns rendering; these helpers keep non-visual sidebar behavior behind a
 * named service boundary for the session screen.
 */

import { state } from '../state.js';
import { sessionsState } from '../screens/sessions-state.js';
import { sessionsClient } from '../ipc/clients.js';
import { logEvent } from '../utils.js';
import type { SessionSortField, SortDirection } from '../sort-logic.js';
import { refreshOverview } from '../screens/group-overview.js';
import {
  loadSessionsData, getTerminalManager,
} from '../screens/sessions.js';

export let sessionsSortField: SessionSortField = 'state';
export let sessionsSortDirection: SortDirection = 'asc';

export function startRename(sessionId: string): void {
  sessionsState.editingSessionId = sessionId;
}

export function cancelRename(): void {
  sessionsState.editingSessionId = null;
}

export async function commitRename(sessionId: string, newName: string): Promise<void> {
  const trimmed = newName.trim();
  if (!trimmed) {
    logEvent('Name cannot be empty');
    return;
  }
  if (trimmed.length > 50) {
    logEvent('Name too long (max 50 chars)');
    return;
  }

  try {
    const result = await sessionsClient.sessionRename(sessionId, trimmed);
    if (result.success) {
      logEvent(`Renamed to: ${trimmed}`);
      sessionsState.editingSessionId = null;
      const tm = getTerminalManager();
      if (tm) tm.renameSession(sessionId, trimmed);
      await loadSessionsData();
      refreshOverview();
    } else {
      logEvent(`Rename failed: ${result.error}`);
      sessionsState.editingSessionId = null;
    }
  } catch (error) {
    console.error('[Sessions] Rename failed:', error);
    logEvent('Rename failed');
    sessionsState.editingSessionId = null;
  }
}

export function updateStatusCounts(): void {
  const totalEl = document.getElementById('statusTotalSessions');
  const activeEl = document.getElementById('statusActiveSessions');
  const localSessions = state.sessions.filter(session => !session.remote);
  if (totalEl) totalEl.textContent = localSessions.length.toString();
  if (activeEl) activeEl.textContent = localSessions.some(s => s.id === state.activeSessionId) ? '1' : '0';
}
