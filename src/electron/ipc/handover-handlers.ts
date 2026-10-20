import { ipcMain } from 'electron';
import type { HandoverDelivery } from '../../session/handover-delivery.js';
import type { WindowManager } from '../window-manager.js';
import { logger } from '../../utils/logger.js';

/**
 * IPC for the pending-handover terminal lock.
 *
 * The lock exists for a mechanical reason, not a decorative one: user keystrokes
 * are PTY output, and PTY output resets the activity timer the handover waits
 * on. Typing into a compacting session pushes the delivery out indefinitely.
 */
export function setupHandoverHandlers(handover: HandoverDelivery, windowManager: WindowManager): () => void {
  ipcMain.handle('handover:cancel', (_event, sessionId: string) => {
    handover.cancel(sessionId);
    return { success: true };
  });

  ipcMain.handle('handover:send-now', (_event, sessionId: string) => {
    handover.sendNow(sessionId);
    return { success: true };
  });

  ipcMain.handle('handover:list', () => handover.pendingIds());

  ipcMain.handle('handover:pending', (_event, sessionId: string) => ({
    pending: handover.isPending(sessionId),
    text: handover.peek(sessionId),
  }));

  // Channel names are written out inline rather than passed through a helper:
  // the IPC contract test greps the source for string-literal sends, and a
  // channel it cannot see is a channel nobody can find later either.
  const onArmed = (event: { sessionId: string }) => {
    const win = windowManager.getWindowForSession(event.sessionId);
    if (win && !win.isDestroyed()) win.webContents.send('handover:armed', event);
  };
  const onDelivered = (event: { sessionId: string }) => {
    const win = windowManager.getWindowForSession(event.sessionId);
    if (win && !win.isDestroyed()) win.webContents.send('handover:delivered', event);
  };
  const onLost = (event: { sessionId: string; reason: string }) => {
    const win = windowManager.getWindowForSession(event.sessionId);
    if (win && !win.isDestroyed()) win.webContents.send('handover:lost', event);
  };

  handover.on('handover-armed', onArmed);
  handover.on('handover-delivered', onDelivered);
  handover.on('handover-lost', onLost);

  logger.info('[Handover IPC] Handlers registered');

  return () => {
    ipcMain.removeHandler('handover:cancel');
    ipcMain.removeHandler('handover:send-now');
    ipcMain.removeHandler('handover:pending');
    ipcMain.removeHandler('handover:list');
    handover.off('handover-armed', onArmed);
    handover.off('handover-delivered', onDelivered);
    handover.off('handover-lost', onLost);
  };
}
