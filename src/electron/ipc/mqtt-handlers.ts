/**
 * MQTT trigger IPC — the Settings page's view of the broker and rules.
 * The broker password never travels to the renderer; it only learns whether one is set.
 */
import { ipcMain, BrowserWindow } from 'electron';
import type { MqttTriggerManager } from '../../session/mqtt-trigger-manager.js';
import type { WindowManager } from '../window-manager.js';
import type { CreateMqttRuleParams, MqttBrokerConfig, MqttSnapshot, UpdateMqttRuleParams } from '../../types/mqtt-trigger.js';

export function mqttSnapshot(manager: MqttTriggerManager): MqttSnapshot {
  const { password, ...broker } = manager.getBroker();
  return { broker: { ...broker, hasPassword: Boolean(password) }, status: manager.getStatus(), rules: manager.listRules() };
}

export function setupMqttHandlers(manager: MqttTriggerManager, windowManager?: WindowManager): void {
  const broadcast = () => {
    const snapshot = mqttSnapshot(manager);
    for (const win of windowManager?.getAllWindows() ?? BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send('mqtt:changed', snapshot);
    }
  };
  manager.on('changed', broadcast);
  manager.on('status', broadcast);

  ipcMain.handle('mqtt:get', () => mqttSnapshot(manager));
  ipcMain.handle('mqtt:setBroker', (_event, update: Partial<MqttBrokerConfig>) => {
    // An omitted password keeps the stored one; an empty string clears it.
    manager.setBroker(update);
    return mqttSnapshot(manager);
  });
  ipcMain.handle('mqtt:createRule', (_event, params: CreateMqttRuleParams) => manager.createRule(params));
  ipcMain.handle('mqtt:updateRule', (_event, id: string, update: UpdateMqttRuleParams) => manager.updateRule(id, update));
  ipcMain.handle('mqtt:deleteRule', (_event, id: string) => manager.deleteRule(id));
}
