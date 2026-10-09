import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const DOCUMENTED_DYNAMIC_RENDERER_EVENT_SENDERS = new Set([
  // session-handlers.ts sends these via a typed notifyMainWindow(channel, sessionId)
  // helper so both snap-out and snap-back lifecycle events share one path.
  'session:snapOut',
  'session:snapBack',
  // PipelineQueue sends this dynamically when auto-handoff occurs between sessions.
  'pty:handoff',
  // FleetController broadcasts these pairing/discovery events through an
  // injected broadcast(channel, payload) closure (P-0658), so the channel is a
  // variable at the webContents.send call site rather than a literal.
  'peer:discovered',
  'peer:lost',
  'peer:incoming',
  'peer:sas',
  'peer:paired',
  'peer:failed',
]);

function readSources(relativeRoots: string[]): string {
  const allowedExtensions = new Set(['.ts', '.vue']);
  const files: string[] = [];

  function walk(dirPath: string): void {
    for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
      const entryPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(entryPath);
        continue;
      }
      if (allowedExtensions.has(path.extname(entry.name))) {
        files.push(entryPath);
      }
    }
  }

  for (const root of relativeRoots) {
    const rootPath = path.resolve(__dirname, '..', root);
    if (fs.statSync(rootPath).isFile()) {
      files.push(rootPath);
    } else {
      walk(rootPath);
    }
  }

  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}

function collect(pattern: RegExp, source: string): string[] {
  return [...new Set(Array.from(source.matchAll(pattern), ([, channel]) => channel))].sort();
}

describe('IPC channel contract', () => {
  const preloadSource = readSources(['src/electron/preload.ts', 'src/electron/preload']);
  const mainSource = readSources(['src/electron', 'src/session']);

  it('has a registered main handler for every preload invoke channel', () => {
    const preloadInvokeChannels = collect(/ipcRenderer\.invoke\(\s*['"]([^'"]+)['"]/g, preloadSource);
    const mainHandleChannels = collect(/(?:ipcMain|ipc)\.handle\(\s*['"]([^'"]+)['"]/g, mainSource);

    expect(preloadInvokeChannels).toEqual(mainHandleChannels);
    expect(preloadInvokeChannels).toContain('peer:cliTypes');
  });

  it('has a registered main listener for every preload send channel', () => {
    const preloadSendChannels = collect(/ipcRenderer\.send\(\s*['"]([^'"]+)['"]/g, preloadSource);
    const mainOnChannels = collect(/ipcMain\.on\(\s*['"]([^'"]+)['"]/g, mainSource);

    expect(preloadSendChannels).toEqual(mainOnChannels);
  });

  it('has a documented main sender for every renderer event subscription', () => {
    const preloadListenerChannels = new Set(collect(/ipcRenderer\.on\(\s*['"]([^'"]+)['"]/g, preloadSource));
    const literalMainSendChannels = new Set(collect(/webContents\.send\(\s*['"]([^'"]+)['"]/g, mainSource));
    const allDocumentedSenders = new Set([
      ...literalMainSendChannels,
      ...DOCUMENTED_DYNAMIC_RENDERER_EVENT_SENDERS,
    ]);

    expect([...preloadListenerChannels].sort()).toEqual([...allDocumentedSenders].sort());
  });
});
