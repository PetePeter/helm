import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhoneLineService } from '../src/phone/phone-line-service.js';
import { TelefonyProcess } from '../src/phone/telefony-process.js';
import { resolvePhoneLineConfig, type PhoneLineConfig } from '../src/phone/phone-config.js';
import { FakePhapServer } from './helpers/fake-phap-server.js';

const OWNER = '+61491570156';
const until = async (pred: () => boolean, ms = 4000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function setup() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'helm-phoneline-'));
  const live = path.join(dir, 'live.js');
  writeFileSync(live, 'setInterval(() => {}, 1000)');
  const server = new FakePhapServer();
  await server.listen();
  const port = Number(new URL(server.uri).port);
  let cfg: PhoneLineConfig = resolvePhoneLineConfig({
    enabled: true, executable: 'telefony-app', transport: 'usb:x', token: 'tok', port, heartbeatS: 1,
    contacts: [{ label: 'Me', pattern: OWNER, role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true }],
  });
  const proc = new TelefonyProcess({
    configPath: path.join(dir, 'telefony.toml'),
    spawnFn: ((_e: string, args: string[], o: object) => spawn(process.execPath, [live, ...args], o)) as unknown as typeof spawn,
  });
  const service = new PhoneLineService({
    getConfig: () => cfg,
    saveConfig: (c) => { cfg = c; },
    telefonyConfigPath: path.join(dir, 'telefony.toml'),
    defaultTranscriptDir: dir,
    getAppVersion: () => 't',
    getOperatorId: () => 'op',
    sessionName: () => 'Operator',
    deliver: async () => undefined,
    log: () => undefined,
    process: proc,
  });
  cleanup.push(() => service.stop(), () => server.close(), () => rmSync(dir, { recursive: true, force: true }));
  return { server, service, proc, getCfg: () => cfg, setCfg: (c: Partial<PhoneLineConfig>) => { cfg = { ...cfg, ...c }; } };
}

const pid = (s: PhoneLineService) => (s.getStatus().process as { pid?: number }).pid;

describe('PhoneLineService', () => {
  it('starts telefony and the link, and defers a config restart until the call ends', async () => {
    const { server, service, setCfg } = await setup();
    await service.apply();
    await until(() => service.isAvailable());
    const first = pid(service);
    expect(first).toBeDefined();

    server.emit('call.ringing', { callId: 'c1', number: OWNER, allowed: true });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => service.getStatus().line?.call?.state === 'active');

    setCfg({ voice: { tts: 'none', piperModel: '', sttModel: 'base.en' } });
    await service.apply();
    expect(service.getStatus().pendingRestart).toBe(true);
    expect(pid(service)).toBe(first);
    await expect(service.restart()).rejects.toThrow(/call is live/);

    server.emit('call.state', { callId: 'c1', state: 'ended', reason: 'remote' });
    await until(() => !service.getStatus().pendingRestart && pid(service) !== first);
  });

  it('a settings save that changes nothing telefony reads does not restart it', async () => {
    const { service, setCfg } = await setup();
    await service.apply();
    const first = pid(service);
    setCfg({ persona: { ...resolvePhoneLineConfig({}).persona, name: 'Sam' } });
    await service.apply();
    expect(pid(service)).toBe(first);
  });

  it('generates a token when none is set, and disabling hangs up and stops', async () => {
    const { server, service, setCfg, getCfg } = await setup();
    setCfg({ token: '' });
    await service.apply();
    expect(getCfg().token).toMatch(/^[\w-]{32}$/);
    setCfg({ token: 'tok' });
    await service.apply();
    await until(() => service.isAvailable());
    server.emit('call.ringing', { callId: 'c1', number: OWNER, allowed: true });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => service.getStatus().line?.call?.state === 'active');
    setCfg({ enabled: false });
    await service.apply();
    expect(await server.waitFor('call.hangup')).toEqual({ callId: 'c1' });
    expect(service.getStatus().process.state).toBe('stopped');
  });
});
