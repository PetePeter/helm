import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  PRELOAD_API_COMPATIBILITY_POLICY,
  PRELOAD_API_DOMAINS,
  PRELOAD_API_DOMAIN_TARGET,
} from '../src/electron/preload-api-contract';
import { createGamepadCliCompatibilityApi } from '../src/electron/preload/domain-bridge';
import { createPreloadDomains, preloadDomainBuilders } from '../src/electron/preload/domain-builders';

function extractPreloadMethodImplementations(): string[] {
  const preloadPath = path.resolve(__dirname, '../src/electron/preload/domain-api.ts');
  const source = fs.readFileSync(preloadPath, 'utf8');
  const match = source.match(/export const PRELOAD_METHOD_IMPLEMENTATIONS = \{([\s\S]*?)\n\} as const;/);

  if (!match) {
    throw new Error('Unable to find PRELOAD_METHOD_IMPLEMENTATIONS object in preload/domain-api.ts');
  }

  return Array.from(match[1].matchAll(/^  ([A-Za-z_$][\w$]*):/gm), ([, method]) => method).sort();
}

function collectLegacyWindowReferences(): string[] {
  const roots = ['renderer', 'src/electron'];
  const allowedExtensions = new Set(['.ts', '.vue']);
  const references: string[] = [];

  function walk(dirPath: string): void {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (!allowedExtensions.has(path.extname(entry.name))) continue;

      const source = fs.readFileSync(entryPath, 'utf8');
      if (source.includes('window.gamepadCli')) {
        references.push(entryPath.replace(/\\/g, '/'));
      }
    }
  }

  for (const root of roots) walk(path.resolve(__dirname, '..', root));
  return [...new Set(references)].sort();
}

describe('preload API boundary contract', () => {
  it('maps every preload method implementation to one target domain', () => {
    const currentMethods = extractPreloadMethodImplementations();
    const mappedEntries = Object.entries(PRELOAD_API_DOMAINS).flatMap(([domain, methods]) =>
      methods.map((method) => ({ domain, method })),
    );
    const mappedMethods = mappedEntries.map(({ method }) => method).sort();
    const duplicateMethods = mappedMethods.filter((method, index) => mappedMethods.indexOf(method) !== index);

    expect(duplicateMethods).toEqual([]);
    expect(mappedMethods).toEqual(currentMethods);
  });

  it('keeps required migration domains explicit', () => {
    expect(PRELOAD_API_DOMAIN_TARGET).toBe('window.helm.<domain>');
    expect(PRELOAD_API_COMPATIBILITY_POLICY.electronBoundary).toContain('contextBridge');
    expect(PRELOAD_API_COMPATIBILITY_POLICY.legacyFacade).toContain('compatibility facade');

    expect(Object.keys(PRELOAD_API_DOMAINS)).toEqual(expect.arrayContaining([
      'app',
      'sessions',
      'terminal',
      'delivery',
      'config',
      'tools',
      'projects',
      'plans',
      'drafts',
      'contexts',
      'memory',
      'attachments',
      'incoming',
      'scheduler',
      'patterns',
      'telegram',
      'keyboard',
      'dialog',
      'system',
      'events',
    ]));
  });

  it('has a preload domain builder for every target domain', () => {
    expect(Object.keys(preloadDomainBuilders).sort()).toEqual(Object.keys(PRELOAD_API_DOMAINS).sort());
  });

  it('creates domain APIs and a flat compatibility facade from the same methods', () => {
    const methodImplementations = Object.fromEntries(
      extractPreloadMethodImplementations().map((method) => [method, () => method]),
    ) as Record<string, () => string>;

    const helmApi = createPreloadDomains(methodImplementations);
    const gamepadCliApi = createGamepadCliCompatibilityApi(helmApi);

    expect(helmApi.sessions.sessionSetActive).toBe(methodImplementations.sessionSetActive);
    expect(helmApi.terminal.ptySpawn).toBe(methodImplementations.ptySpawn);
    expect(helmApi.plans.planCreate).toBe(methodImplementations.planCreate);
    expect(helmApi.drafts.draftCreate).toBe(methodImplementations.draftCreate);
    expect(helmApi.scheduler.scheduledTaskCreate).toBe(methodImplementations.scheduledTaskCreate);
    expect(helmApi.scheduler.scheduledTaskListHistory).toBe(methodImplementations.scheduledTaskListHistory);
    expect(helmApi.scheduler.scheduledTaskClearHistory).toBe(methodImplementations.scheduledTaskClearHistory);
    expect(helmApi.events.onScheduledTaskHistoryChanged).toBe(methodImplementations.onScheduledTaskHistoryChanged);
    expect(helmApi.telegram.telegramStart).toBe(methodImplementations.telegramStart);
    expect(helmApi.peers.peerCliTypes).toBe(methodImplementations.peerCliTypes);
    expect(helmApi.keyboard.keyboardSendKeyCombo).toBe(methodImplementations.keyboardSendKeyCombo);
    expect(helmApi.app.appStartupReady).toBe(methodImplementations.appStartupReady);
    expect(helmApi.app.appConfirmClose).toBe(methodImplementations.appConfirmClose);
    expect(helmApi.events.onAppCloseRequest).toBe(methodImplementations.onAppCloseRequest);

    expect(gamepadCliApi.sessionSetActive).toBe(helmApi.sessions.sessionSetActive);
    expect(gamepadCliApi.planCreate).toBe(helmApi.plans.planCreate);
    expect(gamepadCliApi.appStartupReady).toBe(helmApi.app.appStartupReady);
  });

  it('keeps preload.ts as an exposure shell, not the method owner', () => {
    const preloadSource = fs.readFileSync(path.resolve(__dirname, '../src/electron/preload.ts'), 'utf8');

    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('helm', helmAPI)");
    expect(preloadSource).toContain("contextBridge.exposeInMainWorld('gamepadCli', gamepadCliAPI)");
    expect(preloadSource).not.toContain('legacyGamepadCliAPI');
    expect(preloadSource).not.toContain("ipcRenderer.invoke('session:setActive'");
  });

  it('keeps legacy window.gamepadCli references confined to documented compatibility files', () => {
    expect(collectLegacyWindowReferences()).toEqual([
      path.resolve(__dirname, '../renderer/ipc/clients.ts').replace(/\\/g, '/'),
      path.resolve(__dirname, '../src/electron/main.ts').replace(/\\/g, '/'),
      path.resolve(__dirname, '../src/electron/preload-api-contract.ts').replace(/\\/g, '/'),
    ]);
  });
});
