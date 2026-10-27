import { describe, it, expect, afterEach } from 'vitest';
import { PhapClient, PhapError, type PhapEvent } from '../src/phone/phap-client.js';
import { FakePhapServer } from './helpers/fake-phap-server.js';

const servers: FakePhapServer[] = [];
const clients: PhapClient[] = [];
afterEach(async () => {
  clients.splice(0).forEach((c) => c.stop());
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function setup(token = 'tok') {
  const server = new FakePhapServer();
  await server.listen();
  servers.push(server);
  const client = new PhapClient({ uri: server.uri, token, clientVersion: 't', heartbeatS: 0.05, baseDelayMs: 10 });
  clients.push(client);
  const events: PhapEvent[] = [];
  client.on('event', (e) => events.push(e));
  return { server, client, events };
}

const until = async (pred: () => boolean, ms = 3000) => {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > ms) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

describe('PhapClient', () => {
  it('says hello as controller and runs requests', async () => {
    const { server, client } = await setup();
    server.handlers.set('call.dial', () => ({ callId: 'c1' }));
    client.start();
    await until(() => client.isConnected());
    expect(server.requests[0]).toMatchObject({ method: 'hello', params: { role: 'controller', protocolVersion: '2026-10-27', token: 'tok' } });
    await expect(client.request('call.dial', { number: '+61491570156' })).resolves.toEqual({ callId: 'c1' });
  });

  it('surfaces server errors as PhapError with the code', async () => {
    const { server, client } = await setup();
    server.handlers.set('sms.send', () => { throw Object.assign(new Error('not_allowed'), { code: 1001 }); });
    client.start();
    await until(() => client.isConnected());
    const err = await client.request('sms.send', {}).catch((e: PhapError) => e);
    expect(err).toBeInstanceOf(PhapError);
    expect((err as PhapError).code).toBe(1001);
  });

  it('delivers events without heartbeats', async () => {
    const { server, client, events } = await setup();
    client.start();
    await until(() => client.isConnected());
    server.emit('call.ringing', { callId: 'c1', number: '+61491570156', allowed: true });
    await until(() => events.length === 1);
    await new Promise((r) => setTimeout(r, 120));
    expect(events.map((e) => e.type)).toEqual(['call.ringing']);
  });

  it('resumes after a dropped socket and receives the missed events once', async () => {
    const { server, client, events } = await setup();
    client.start();
    await until(() => client.isConnected());
    server.heartbeats = false;
    server.emit('call.ringing', { callId: 'c1' });
    await until(() => events.length === 1);
    server.dropAll();
    server.emit('call.state', { callId: 'c1', state: 'ended' });
    await until(() => events.length === 2);
    expect(events.map((e) => e.type)).toEqual(['call.ringing', 'call.state']);
    const hellos = server.requests.filter((r) => r.method === 'hello');
    expect(hellos[1].params.resumeFrom).toBe(events[0].seq);
  });

  it('declares a silent socket dead and reconnects', async () => {
    const { server, client } = await setup();
    let dead = 0;
    client.on('dead', () => dead++);
    client.start();
    await until(() => client.isConnected());
    server.heartbeats = false;
    await until(() => dead === 1);
    server.heartbeats = true;
    await until(() => client.isConnected());
  });

  it('never connects with a wrong token and rejects requests meanwhile', async () => {
    const { client } = await setup('nope');
    client.start();
    await new Promise((r) => setTimeout(r, 100));
    expect(client.isConnected()).toBe(false);
    await expect(client.request('status')).rejects.toMatchObject({ code: 1002 });
  });
});
