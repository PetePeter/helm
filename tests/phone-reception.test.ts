import { describe, it, expect } from 'vitest';
import { Reception, matchContactByName, type ReceptionPort } from '../src/phone/phone-reception.js';
import { resolvePhoneLineConfig, type PhoneContact } from '../src/phone/phone-config.js';

const cfg = resolvePhoneLineConfig({
  enabled: true, countryCode: '+61',
  masters: { callIn: true, callOut: true, smsIn: true, smsOut: true, conference: true },
  contacts: [
    { label: 'Oscar', pattern: '+61491570156', role: 'owner', callIn: true, smsOut: true },
    { label: 'Agnes Smith', pattern: '+61491570187', role: 'trusted', callIn: true, smsOut: true, conf: true },
    { label: 'Bob', pattern: '+61491570111', role: 'trusted', callIn: true, smsOut: true, messages: true },
    { label: 'Spammer', pattern: '+61400000000', role: 'blocked' },
  ],
});

const last = <T,>(a: T[]): T => a[a.length - 1];

class FakePort implements ReceptionPort {
  said: string[] = [];
  log: string[] = [];
  texts: Array<{ to: string; text: string }> = [];
  async say(text: string) { this.said.push(text); }
  async hold() { this.log.push('hold'); }
  async resume() { this.log.push('resume'); }
  async conference(c: PhoneContact) { this.log.push(`conference ${c.label}`); }
  async sms(c: PhoneContact, text: string) { this.texts.push({ to: c.label, text }); }
  async hangup() { this.log.push('hangup'); }
}

function setup(holdMs = 60_000) {
  const port = new FakePort();
  const r = new Reception({ caller: '+61299990000', getConfig: () => cfg, port, holdMs });
  return { port, r };
}

describe('matchContactByName', () => {
  it('matches a first name or full label, case-insensitively, within a sentence', () => {
    expect(matchContactByName('Can I speak to agnes please', cfg)?.label).toBe('Agnes Smith');
    expect(matchContactByName('OSCAR.', cfg)?.label).toBe('Oscar');
  });
  it('never matches a blocked row or an unknown name', () => {
    expect(matchContactByName('spammer', cfg)).toBeNull();
    expect(matchContactByName('Gertrude', cfg)).toBeNull();
  });
});

describe('Reception', () => {
  it('greets without naming anyone', async () => {
    const { port, r } = setup();
    await r.onAnswered();
    expect(port.said[0]).toMatch(/who would you like/i);
    for (const name of ['Oscar', 'Agnes', 'Bob']) expect(port.said.join(' ')).not.toContain(name);
  });

  it('an unknown name gets the generic line, then the message goes to the general-message list', async () => {
    const { port, r } = setup();
    await r.onAnswered();
    await r.onUtterance('Gertrude please');
    expect(last(port.said)).toMatch(/isn't available here/);
    expect(port.said.join(' ')).not.toMatch(/Oscar|Agnes|Bob/);
    await r.onUtterance('I sell shoes, call me back');
    await r.onEnded();
    expect(port.texts.map((t) => t.to).sort()).toEqual(['Bob', 'Oscar']);
    expect(port.texts[0].text).toContain('+61299990000');
    expect(port.texts[0].text).toContain('I sell shoes, call me back');
  });

  it('saying "message" goes straight to taking one', async () => {
    const { port, r } = setup();
    await r.onAnswered();
    await r.onUtterance('message');
    await r.onUtterance('hello there');
    await r.onEnded();
    expect(port.texts.some((t) => t.to === 'Oscar' && t.text.includes('hello there'))).toBe(true);
  });

  it('a known name: hold, text that person; JOIN conferences them in', async () => {
    const { port, r } = setup();
    await r.onAnswered();
    await r.onUtterance('Agnes');
    expect(port.log).toEqual(['hold']);
    expect(port.texts).toEqual([{ to: 'Agnes Smith', text: expect.stringMatching(/JOIN/) }]);
    expect(await r.onSmsFrom(cfg.contacts[0], 'JOIN')).toBe(false);
    expect(await r.onSmsFrom(cfg.contacts[1], ' join ')).toBe(true);
    expect(port.log).toEqual(['hold', 'resume', 'conference Agnes Smith']);
  });

  it('a texted reply is read out, and the caller\'s answer goes back to that person only', async () => {
    const { port, r } = setup();
    await r.onAnswered();
    await r.onUtterance('agnes');
    await r.onSmsFrom(cfg.contacts[1], 'Busy, try tomorrow');
    expect(port.log).toEqual(['hold', 'resume']);
    expect(last(port.said)).toContain('Busy, try tomorrow');
    await r.onUtterance('ok thanks');
    await r.onEnded();
    expect(port.texts.map((t) => t.to)).toEqual(['Agnes Smith', 'Agnes Smith']);
    expect(port.texts[1].text).toContain('ok thanks');
  });

  it('no reply in time: resume and take a message for the named person', async () => {
    const { port, r } = setup(20);
    await r.onAnswered();
    await r.onUtterance('Agnes');
    await new Promise((res) => setTimeout(res, 60));
    expect(port.log).toEqual(['hold', 'resume']);
    expect(last(port.said)).toMatch(/leave a message/i);
    await r.onUtterance('call me');
    await r.onEnded();
    expect(last(port.texts)).toMatchObject({ to: 'Agnes Smith', text: expect.stringContaining('call me') });
  });

  it('sends nothing when the caller said nothing', async () => {
    const { port, r } = setup();
    await r.onAnswered();
    await r.onEnded();
    expect(port.texts).toEqual([]);
  });
});
