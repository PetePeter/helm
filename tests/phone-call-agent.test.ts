import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PhapClient } from '../src/phone/phap-client.js';
import { PhoneBridge } from '../src/phone/phone-bridge.js';
import { resolvePhoneLineConfig, type PhoneLineConfig } from '../src/phone/phone-config.js';
import type { ChatClient, ChatMessage, CompletionResult } from '../src/session/api/api-agent-loop.js';
import { FakePhapServer } from './helpers/fake-phap-server.js';

const OWNER = '+61491570156';
const SHOP = '0298765432';

function config(over: Record<string, unknown> = {}): PhoneLineConfig {
  return resolvePhoneLineConfig({
    enabled: true, countryCode: '+61',
    masters: { callIn: true, callOut: true, smsIn: true, smsOut: true, conference: true },
    contacts: [
      { label: 'Me', pattern: OWNER, role: 'owner', pin: '246813', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true },
    ],
    limits: { callsPerHour: 3, smsPerHour: 10, maxCallMin: 0, quietStart: '', quietEnd: '' },
    ...over,
  });
}

/** A model that answers from a script, one step per request; it records what it was sent. */
class ScriptedModel implements ChatClient {
  readonly seen: ChatMessage[][] = [];
  constructor(private readonly steps: Array<CompletionResult['message'] | Error>) {}
  async complete(messages: ChatMessage[]): Promise<CompletionResult> {
    this.seen.push(messages);
    const step = this.steps.shift() ?? { content: '' };
    if (step instanceof Error) throw step;
    return { message: step };
  }
}

const tool = (name: string, args: Record<string, unknown> = {}) => ({
  content: null,
  tool_calls: [{ id: `t-${name}-${Math.random()}`, type: 'function' as const, function: { name, arguments: JSON.stringify(args) } }],
});

const until = async (pred: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

async function setup(model: ChatClient | null, cfg = config()) {
  const server = new FakePhapServer();
  await server.listen();
  server.handlers.set('call.dial', () => ({ callId: 'a1' }));
  server.handlers.set('transcript.get', () => ({ callId: 'a1', utterances: [] }));
  const client = new PhapClient({ uri: server.uri, token: 'tok', clientVersion: 't', heartbeatS: 1, baseDelayMs: 10 });
  const dir = mkdtempSync(path.join(os.tmpdir(), 'helm-agent-'));
  const delivered: Array<{ sessionId: string; text: string }> = [];
  const bridge = new PhoneBridge({
    client,
    getConfig: () => cfg,
    getOperatorId: () => 'op',
    sessionName: () => undefined,
    deliver: async (sessionId, text) => { delivered.push({ sessionId, text }); },
    defaultTranscriptDir: dir,
    smsPollMs: 0,
    callAgentModel: () => model,
  });
  bridge.start();
  client.start();
  cleanup.push(() => { bridge.stop(); client.stop(); }, () => server.close(), () => rmSync(dir, { recursive: true, force: true }));
  await until(() => client.isConnected());
  return { server, bridge, delivered };
}

/** Dial, then connect the far end. */
async function connect(server: FakePhapServer) {
  await server.waitFor('call.dial');
  await new Promise((r) => setTimeout(r, 30));
  server.emit('call.state', { callId: 'a1', state: 'active' });
}

describe('Call agent', () => {
  it('is off without a picked model: nothing is dialled', async () => {
    const { server, bridge } = await setup(null);
    await expect(bridge.startCallAgent('op', { to: SHOP, task: 'Book a table' })).rejects.toThrow(/call agent model/i);
    expect(server.requests.some((r) => r.method === 'call.dial')).toBe(false);
  });

  it('talks, presses keys, hangs up and reports to the requester only', async () => {
    const model = new ScriptedModel([
      { content: 'Hello, I am calling to book a table.' },
      tool('press_keys', { digits: '2#' }),
      { content: '' },
      tool('hang_up', { summary: 'Table booked for 7pm.' }),
    ]);
    const { server, bridge, delivered } = await setup(model);
    await bridge.startCallAgent('worker', { to: SHOP, task: 'Book a table for two at 7pm' });
    expect(await server.waitFor('call.dial')).toEqual({ number: '+61298765432' });
    await connect(server);
    expect((await server.waitFor('call.say')).text).toBe('Hello, I am calling to book a table.');
    server.emit('call.utterance', { callId: 'a1', text: 'Press 2 for bookings.' });
    expect(await server.waitFor('call.sendDtmf')).toEqual({ callId: 'a1', digits: '2#' });
    server.emit('call.utterance', { callId: 'a1', text: 'Bookings, how can I help?' });
    await server.waitFor('call.hangup');
    server.emit('call.state', { callId: 'a1', state: 'ended' });
    await until(() => delivered.length > 0);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].sessionId).toBe('worker');
    expect(delivered[0].text).toContain('Table booked for 7pm.');
    // The task and the far end's words reached the model; the operator heard nothing.
    expect(JSON.stringify(model.seen[model.seen.length - 1])).toContain('Press 2 for bookings.');
    expect(JSON.stringify(model.seen[0])).toContain('Book a table for two at 7pm');
  });

  it('refuses costly numbers and an unverified caller on the line', async () => {
    const { server, bridge } = await setup(new ScriptedModel([]));
    await expect(bridge.startCallAgent('op', { to: '+4420794601', task: 'x' })).rejects.toThrow(/international/);
    await expect(bridge.startCallAgent('op', { to: '1900123456', task: 'x' })).rejects.toThrow(/premium/);
    // The owner calls in but has not keyed their PIN.
    server.emit('call.ringing', { callId: 'c1', number: OWNER, allowed: true });
    await server.waitFor('call.answer');
    server.emit('call.state', { callId: 'c1', state: 'active' });
    await until(() => bridge.getStatus().call?.state === 'active');
    await expect(bridge.startCallAgent('op', { to: SHOP, task: 'x' })).rejects.toThrow(/PIN/);
  });

  it('gives up after the requester max wait and reports it', async () => {
    const { server, bridge, delivered } = await setup(new ScriptedModel([{ content: '' }]));
    await bridge.startCallAgent('worker', { to: SHOP, task: 'Wait for a human', maxWaitMin: 0.002 });
    await connect(server);
    await server.waitFor('call.hangup');
    server.emit('call.state', { callId: 'a1', state: 'ended' });
    await until(() => delivered.length > 0);
    expect(delivered[0].text).toMatch(/gave up/i);
  });

  it('joining the requester cancels the max wait', async () => {
    const model = new ScriptedModel([tool('join_requester'), { content: '' }]);
    const { server, bridge } = await setup(model);
    await bridge.startCallAgent('worker', { to: SHOP, task: 'Get me a human', maxWaitMin: 0.003 });
    await connect(server);
    expect(await server.waitFor('conference.create')).toEqual({ callId: 'a1', number: OWNER });
    await new Promise((r) => setTimeout(r, 300));
    expect(server.requests.some((r) => r.method === 'call.hangup')).toBe(false);
  });

  it('a model failure says goodbye, hangs up and reports the failure', async () => {
    const { server, bridge, delivered } = await setup(new ScriptedModel([new Error('API 503: down')]));
    await bridge.startCallAgent('worker', { to: SHOP, task: 'x' });
    await connect(server);
    expect((await server.waitFor('call.say')).text).toMatch(/goodbye/i);
    await server.waitFor('call.hangup');
    server.emit('call.state', { callId: 'a1', state: 'ended' });
    await until(() => delivered.length > 0);
    expect(delivered[0].text).toContain('API 503');
  });
});
