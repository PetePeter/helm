import { describe, it, expect, afterEach } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TelefonyProcess, renderTelefonyToml, type TelefonyStatus } from '../src/phone/telefony-process.js';
import { resolvePhoneLineConfig } from '../src/phone/phone-config.js';

const dir = mkdtempSync(path.join(os.tmpdir(), 'helm-telefony-'));
const script = (name: string, body: string) => { const p = path.join(dir, name); writeFileSync(p, body); return p; };
const CRASH = script('crash.js', 'process.exit(3)');
const LIVE = script('live.js', 'setInterval(() => {}, 1000)');

/** Runs a node script in place of telefony-app; the TOML path is still passed through. */
const nodeRunning = (file: string) => ((_exe: string, args: string[], o: object) => spawn(process.execPath, [file, ...args], o)) as unknown as typeof spawn;

const cfg = (over: Record<string, unknown> = {}) => resolvePhoneLineConfig({
  enabled: true, executable: 'telefony-app', transport: 'usb:10D7:B012', token: 'tok', countryCode: '+61',
  contacts: [
    { label: 'Me', pattern: '0491570156', role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true },
    { label: 'Office', pattern: '+61299*', role: 'trusted', callIn: true },
    { label: 'Spam', pattern: '+61400000000', role: 'trusted', callIn: true },
    { label: 'Dormant', pattern: '+61411111111', role: 'trusted' },
  ],
  blocklist: ['^0400000000$'],
  ...over,
});

const procs: TelefonyProcess[] = [];
afterEach(async () => { await Promise.all(procs.splice(0).map((p) => p.stop())); });

function waitFor(p: TelefonyProcess, pred: (s: TelefonyStatus) => boolean, ms = 5000): Promise<TelefonyStatus> {
  return new Promise((resolve, reject) => {
    if (pred(p.getStatus())) return resolve(p.getStatus());
    const t = setTimeout(() => reject(new Error(`timeout; last ${JSON.stringify(p.getStatus())}`)), ms);
    p.on('status', (s: TelefonyStatus) => { if (pred(s)) { clearTimeout(t); resolve(s); } });
  });
}

describe('renderTelefonyToml', () => {
  it('allowlists only exact, enabled, non-blocked numbers, normalised', () => {
    const toml = renderTelefonyToml(cfg());
    expect(toml).toContain('allowlist = ["+61491570156"]');
    expect(toml).toContain('bind = "127.0.0.1:7781"');
    expect(toml).toContain('token = "tok"');
    expect(toml).not.toContain('piper_model');
  });
  it('lets Helm dial any number: the dial-out guard lives in Helm, not the allowlist', () => {
    const policy = renderTelefonyToml(cfg()).split('[policy]')[1].split(/\n\[/)[0];
    expect(policy).toContain('\noutbound = "all"\n');
  });
  it('quotes values safely', () => {
    expect(renderTelefonyToml(cfg({ transport: 'a"b\\c' }))).toContain('transport = "a\\"b\\\\c"');
  });
});

describe('TelefonyProcess', () => {
  it('stops retrying when the Bluetooth dongle is missing', async () => {
    const NO_DONGLE = script('nodongle.js', 'process.stderr.write("telefony-app: dongle not found\\n(device not found; check it is plugged in)\\n"); process.exit(3)');
    const p = new TelefonyProcess({ configPath: path.join(dir, 'nd', 'telefony.toml'), spawnFn: nodeRunning(NO_DONGLE), baseDelayMs: 10 });
    procs.push(p);
    await p.start(cfg());
    const s = await waitFor(p, (st) => st.state === 'failed');
    expect(s).toMatchObject({ state: 'failed', lastError: expect.stringMatching(/dongle not found/) });
  });

  it('writes the TOML and passes its path to the process', async () => {
    const configPath = path.join(dir, 'a', 'telefony.toml');
    const p = new TelefonyProcess({ configPath, spawnFn: nodeRunning(LIVE) });
    procs.push(p);
    await p.start(cfg());
    expect(p.getStatus().state).toBe('running');
    expect(readFileSync(configPath, 'utf8')).toContain('[policy]');
  });

  it('restarts a crashing process with backoff, then gives up', async () => {
    const p = new TelefonyProcess({ configPath: path.join(dir, 'b.toml'), spawnFn: nodeRunning(CRASH), baseDelayMs: 10, maxRestarts: 2 });
    procs.push(p);
    const seen: TelefonyStatus[] = [];
    p.on('status', (s) => seen.push(s));
    await p.start(cfg());
    const final = await waitFor(p, (s) => s.state === 'failed');
    expect(final).toMatchObject({ state: 'failed' });
    expect(seen.filter((s) => s.state === 'backoff').map((s) => (s as { restartInMs: number }).restartInMs)).toEqual([10, 20]);
  });

  it('does not restart when the watchdog is off', async () => {
    const p = new TelefonyProcess({ configPath: path.join(dir, 'c.toml'), spawnFn: nodeRunning(CRASH), baseDelayMs: 10 });
    procs.push(p);
    await p.start(cfg({ watchdog: false }));
    await waitFor(p, (s) => s.state === 'failed');
  });

  it('re-applying settings to a running process restarts it without a crash backoff', async () => {
    const p = new TelefonyProcess({ configPath: path.join(dir, 'e.toml'), spawnFn: nodeRunning(LIVE), baseDelayMs: 10 });
    procs.push(p);
    await p.start(cfg());
    const seen: string[] = [];
    p.on('status', (s: TelefonyStatus) => seen.push(s.state));
    await Promise.all([p.start(cfg()), p.start(cfg())]);
    expect(seen).not.toContain('backoff');
    expect(p.getStatus()).toMatchObject({ state: 'running', restarts: 0 });
  });

  it('restart() on a dead link kills and relaunches; stop() kills for good', async () => {
    const p = new TelefonyProcess({ configPath: path.join(dir, 'd.toml'), spawnFn: nodeRunning(LIVE), baseDelayMs: 10 });
    procs.push(p);
    await p.start(cfg());
    const first = p.getStatus() as { pid: number };
    await p.restart('no heartbeat');
    const again = await waitFor(p, (s) => s.state === 'running') as { pid: number };
    expect(again.pid).not.toBe(first.pid);
    await p.stop();
    expect(p.getStatus().state).toBe('stopped');
    expect(() => process.kill(again.pid, 0)).toThrow();
  });
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
