/**
 * Phone line IPC (Settings > Phone line): settings CRUD, live status, and the
 * restart / test buttons. See docs/phone-line.md.
 */
import { ipcMain, type WebContents } from 'electron';
import type { ConfigLoader } from '../../config/loader.js';
import type { PhoneLineConfig } from '../../phone/phone-config.js';
import type { PhoneLineService, PhoneLineStatus } from '../../phone/phone-line-service.js';
import { installedVersionOf, type TelefonyInstaller } from '../../phone/telefony-installer.js';
import { logger } from '../../utils/logger.js';

const CHANNELS = [
  'phone:getConfig', 'phone:setConfig', 'phone:getStatus', 'phone:restart', 'phone:testRing', 'phone:testSms',
  'phone:telefonyCheck', 'phone:telefonyInstall',
] as const;

export function setupPhoneHandlers(
  configLoader: ConfigLoader,
  phoneLine: PhoneLineService,
  installer: TelefonyInstaller,
  installRoot: string,
  getWebContents: () => WebContents | null,
): () => void {
  const wrap = async <T>(fn: () => T | Promise<T>) => {
    try {
      return { success: true as const, value: await fn() };
    } catch (error) {
      logger.warn(`[IPC] phone: ${(error as Error).message}`);
      return { success: false as const, error: (error as Error).message };
    }
  };

  ipcMain.handle('phone:getConfig', () => configLoader.getPhoneLineConfig());
  ipcMain.handle('phone:setConfig', (_e, cfg: Partial<PhoneLineConfig>) => wrap(async () => {
    const saved = configLoader.setPhoneLineConfig(cfg);
    await phoneLine.apply();
    return saved;
  }));
  ipcMain.handle('phone:getStatus', () => phoneLine.getStatus());
  ipcMain.handle('phone:restart', () => wrap(() => phoneLine.restart()));
  ipcMain.handle('phone:testRing', () => wrap(() => {
    if (!phoneLine.testRing()) throw new Error('Could not ring: check the line is connected, an owner is set, and the operator is on.');
  }));
  ipcMain.handle('phone:testSms', () => wrap(async () => {
    const r = await phoneLine.testSms();
    if (!r.sent) throw new Error(r.reason ?? 'not sent');
  }));

  ipcMain.handle('phone:telefonyCheck', () => wrap(async () => ({
    installed: installedVersionOf(installRoot, configLoader.getPhoneLineConfig().executable),
    latest: await installer.latest(),
  })));
  ipcMain.handle('phone:telefonyInstall', () => wrap(async () => {
    const release = await installer.latest();
    if (!release) throw new Error('No telefony-app release is published yet');
    const executable = await installer.install(release, (progress) => {
      const webContents = getWebContents();
      if (webContents && !webContents.isDestroyed()) webContents.send('phone:telefonyProgress', progress);
    });
    configLoader.setPhoneLineConfig({ executable });
    await phoneLine.apply();
    installer.pruneExcept(release.version);
    return { version: release.version, executable };
  }));

  const push = (status: PhoneLineStatus) => {
    const webContents = getWebContents();
    if (webContents && !webContents.isDestroyed()) webContents.send('phone:status', status);
  };
  phoneLine.on('status', push);

  return () => {
    phoneLine.off('status', push);
    for (const c of CHANNELS) ipcMain.removeHandler(c);
  };
}
