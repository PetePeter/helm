import { describe, it, expect } from 'vitest';
import {
  decide, decideDialOut, normalizeNumber, resolvePhoneLineConfig, inQuietHours, fillTemplate, maskOtp, findContact,
  type PhoneLineConfig, type DecideContext,
} from '../src/phone/phone-config.js';

const ctx = (over: Partial<DecideContext> = {}): DecideContext => ({ now: new Date(2026, 9, 28, 12, 0), callsLastHour: 0, smsLastHour: 0, ...over });

function cfg(over: Record<string, unknown> = {}): PhoneLineConfig {
  return resolvePhoneLineConfig({
    countryCode: '+61',
    masters: { callIn: true, callOut: true, smsIn: true, smsOut: true, conference: true },
    contacts: [
      { label: 'Me', pattern: '+61491570156', role: 'owner', callIn: true, callOut: true, smsIn: true, smsOut: true, conf: true },
      { label: 'Partner', pattern: '0491 570 187', role: 'trusted', callIn: true, callOut: false, smsIn: true, smsOut: false, conf: true },
      { label: 'Office', pattern: '+61299*', role: 'trusted', callIn: true, callOut: false, smsIn: false, smsOut: false, conf: false },
    ],
    blocklist: ['^\\+612999'],
    ...over,
  });
}

describe('normalizeNumber', () => {
  it('reads national, 00 and formatted forms as E.164', () => {
    expect(normalizeNumber('0491 570 156', '+61')).toBe('+61491570156');
    expect(normalizeNumber('0061491570156', '+61')).toBe('+61491570156');
    expect(normalizeNumber('+61 (491) 570-156', '+61')).toBe('+61491570156');
  });
  it('rejects withheld and control characters', () => {
    expect(normalizeNumber('', '+61')).toBeNull();
    expect(normalizeNumber('Private', '+61')).toBeNull();
    expect(normalizeNumber('+61491570156;ATD', '+61')).toBeNull();
  });
});

describe('decide', () => {
  it('allows the owner every action and returns the contact', () => {
    for (const a of ['call.in', 'call.out', 'sms.in', 'sms.out', 'conf.add'] as const) {
      const d = decide(a, '0491570156', cfg(), ctx());
      expect(d).toMatchObject({ allow: true, number: '+61491570156' });
    }
  });
  it('applies per-contact switches', () => {
    expect(decide('call.in', '+61491570187', cfg(), ctx()).allow).toBe(true);
    expect(decide('sms.out', '+61491570187', cfg(), ctx())).toEqual({ allow: false, reason: 'sms.out is off for Partner' });
  });
  it('a prefix can never hold owner rights', () => {
    const c = resolvePhoneLineConfig({ contacts: [{ label: 'All', pattern: '+61*', role: 'owner', callIn: true }] });
    expect(c.contacts[0].role).toBe('trusted');
  });
  it('a row with no number yet matches nothing', () => {
    const c = resolvePhoneLineConfig({ contacts: [{ label: 'new', pattern: '', role: 'owner', callIn: true }] });
    expect(c.contacts).toHaveLength(1);
    expect(decide('call.in', '+61400000000', c, ctx()).allow).toBe(false);
  });
  it('denies unlisted and withheld numbers', () => {
    expect(decide('call.in', '+61400000000', cfg(), ctx())).toEqual({ allow: false, reason: 'not listed' });
    expect(decide('call.in', '', cfg(), ctx()).allow).toBe(false);
  });
  it('the block list wins over a broader trusted prefix', () => {
    expect(decide('call.in', '+61299912345', cfg(), ctx())).toEqual({ allow: false, reason: 'blocked' });
    expect(decide('call.in', '+61299812345', cfg(), ctx()).allow).toBe(true);
  });
  it('master switch off denies even the owner', () => {
    const c = cfg({ masters: { callIn: false, callOut: true, smsIn: true, smsOut: true, conference: false } });
    expect(decide('call.in', '+61491570156', c, ctx()).allow).toBe(false);
    expect(decide('conf.add', '+61491570156', c, ctx()).allow).toBe(false);
  });
  it('enforces hourly limits on outbound only', () => {
    const c = cfg({ limits: { callsPerHour: 1, smsPerHour: 1, maxCallMin: 15, quietStart: '', quietEnd: '' } });
    expect(decide('call.out', '+61491570156', c, ctx({ callsLastHour: 1 })).allow).toBe(false);
    expect(decide('sms.out', '+61491570156', c, ctx({ smsLastHour: 1 })).allow).toBe(false);
    expect(decide('call.in', '+61491570156', c, ctx({ callsLastHour: 9 })).allow).toBe(true);
  });
  it('quiet hours block outbound unless an urgent owner ring', () => {
    const c = cfg({ limits: { callsPerHour: 3, smsPerHour: 10, maxCallMin: 15, quietStart: '23:00', quietEnd: '07:30' } });
    const night = ctx({ now: new Date(2026, 9, 28, 2, 0) });
    expect(decide('call.out', '+61491570156', c, night)).toEqual({ allow: false, reason: 'quiet hours' });
    expect(decide('call.out', '+61491570156', c, { ...night, urgent: true }).allow).toBe(true);
  });
  it('refuses to grow a full conference', () => {
    expect(decide('conf.add', '+61491570187', cfg(), ctx({ participants: 3 }))).toEqual({ allow: false, reason: 'conference is full' });
  });
});

describe('decideDialOut', () => {
  const out = (n: string, over: Partial<Parameters<typeof decideDialOut>[2]> = {}, c = cfg()) =>
    decideDialOut(n, c, { verified: true, callsLastHour: 0, ...over });

  it('lets a verified caller dial any national number, listed or not', () => {
    expect(out('02 9374 4000')).toEqual({ allow: true, number: '+61293744000' });
  });
  it('refuses an unverified caller', () => {
    expect(out('0293744000', { verified: false })).toMatchObject({ allow: false, reason: expect.stringMatching(/PIN/) });
  });
  it('blocks international numbers for everyone, in every spelling', () => {
    for (const n of ['+44 20 7946 0000', '0044207946000', '0011 44 20 7946 0000', '+1 212 555 0100']) {
      expect(out(n)).toMatchObject({ allow: false, reason: 'international numbers are blocked' });
    }
  });
  it('blocks premium 19xx numbers even with an empty block list', () => {
    const c = cfg({ blocklist: [] });
    expect(out('1900 123 456', {}, c)).toMatchObject({ allow: false });
    expect(out('0190 0123 456', {}, c)).toMatchObject({ allow: false, reason: 'premium numbers are blocked' });
    expect(out('+61 1900 123 456', {}, c)).toMatchObject({ allow: false, reason: 'premium numbers are blocked' });
  });
  it('the block list stops dial-outs too, matched on the national form as well', () => {
    expect(out('0293744000', {}, cfg({ blocklist: ['^0293'] }))).toMatchObject({ allow: false, reason: 'blocked' });
  });
  it('fails closed when the country code is missing or malformed', () => {
    for (const countryCode of ['', '+', '+6', '61', '+61x', '+44']) {
      expect(out('+61293744000', {}, cfg({ countryCode }))).toMatchObject({ allow: false, reason: expect.stringMatching(/country code/) });
    }
  });
  it('caps dial-outs per hour', () => {
    expect(out('0293744000', { callsLastHour: 3 })).toMatchObject({ allow: false, reason: 'hourly call limit reached' });
  });
  it('still honours a blocked entry and the outgoing-calls master switch', () => {
    expect(out('+61299912345')).toMatchObject({ allow: false, reason: 'blocked' });
    const c = cfg({ masters: { callIn: true, callOut: false, smsIn: true, smsOut: true, conference: true } });
    expect(out('0293744000', {}, c)).toMatchObject({ allow: false });
  });
});

describe('decide — cost guard', () => {
  it('blocks premium and international even for the owner row', () => {
    const c = cfg({ contacts: [{ label: 'Me', pattern: '+447946000000', role: 'owner', callOut: true, smsOut: true }] });
    expect(decide('call.out', '+447946000000', c, ctx())).toMatchObject({ allow: false, reason: 'international numbers are blocked' });
    expect(decide('sms.out', '+447946000000', c, ctx())).toMatchObject({ allow: false });
  });
});

describe('block list', () => {
  it('matches each regex against the E.164 and the national form', () => {
    const c = cfg({ blocklist: ['^0400', '5555$'] });
    expect(decide('call.in', '+61400000000', c, ctx())).toEqual({ allow: false, reason: 'blocked' });
    expect(decide('sms.in', '0491 575 555', c, ctx())).toEqual({ allow: false, reason: 'blocked' });
  });
  it('blocks the owner number too', () => {
    expect(decide('sms.out', '+61491570156', cfg({ blocklist: ['^\\+61491570156$'] }), ctx())).toMatchObject({ allow: false, reason: 'blocked' });
  });
  it('moves the old cost-prefix list into the block list', () => {
    const c = cfg({ blocklist: undefined, limits: { callsPerHour: 3, smsPerHour: 10, maxCallMin: 0, quietStart: '', quietEnd: '', blockedPrefixes: ['02 9374'] } });
    expect(decide('call.out', '0293744000', c, ctx())).toMatchObject({ allow: false, reason: 'blocked' });
  });
  it('refuses a number longer than E.164 allows before any regex runs', () => {
    expect(decide('call.in', `+61${'0'.repeat(40)}`, cfg({ blocklist: ['^(0+)+$'] }), ctx())).toEqual({ allow: false, reason: 'blocked' });
  });
  it('drops entries that are not valid regexes, keeping the rest', () => {
    expect(cfg({ blocklist: ['(', '^0400', '', 7] }).blocklist).toEqual(['^0400']);
  });
  it('moves old blocked contact rows into the list as exact or prefix matches', () => {
    const c = cfg({ blocklist: undefined, contacts: [
      { label: 'Me', pattern: '+61491570156', role: 'owner', callIn: true },
      { label: 'Spam', pattern: '0400 000 000', role: 'blocked' },
      { label: 'Spam range', pattern: '+612999*', role: 'blocked' },
    ] });
    expect(c.contacts.map((x) => x.label)).toEqual(['Me']);
    expect(decide('call.in', '+61400000000', c, ctx())).toEqual({ allow: false, reason: 'blocked' });
    expect(decide('call.in', '+61299912345', c, ctx())).toEqual({ allow: false, reason: 'blocked' });
    expect(decide('call.in', '+61491570156', c, ctx()).allow).toBe(true);
  });
});

describe('inQuietHours', () => {
  it('handles windows that wrap midnight and empty windows', () => {
    const c = cfg({ limits: { callsPerHour: 3, smsPerHour: 10, maxCallMin: 15, quietStart: '23:00', quietEnd: '07:30' } });
    expect(inQuietHours(c, new Date(2026, 0, 1, 23, 30))).toBe(true);
    expect(inQuietHours(c, new Date(2026, 0, 1, 7, 30))).toBe(false);
    expect(inQuietHours(cfg(), new Date(2026, 0, 1, 3, 0))).toBe(false);
  });
});

describe('resolvePhoneLineConfig', () => {
  it('fills defaults, drops wrong-typed values and contacts with an unknown role', () => {
    const c = resolvePhoneLineConfig({ port: 'x', persona: { name: 'Sam' }, contacts: [{ label: 'x', pattern: '+61400000000', role: 'admin' }] });
    expect(c.port).toBe(7781);
    expect(c.persona.name).toBe('Sam');
    expect(c.persona.greetIn).toBe(true);
    expect(c.contacts).toEqual([]);
  });
});

describe('helpers', () => {
  it('fillTemplate fills known tokens and collapses blanks', () => {
    expect(fillTemplate('Hi {caller}, this is {name}. {reason}', { caller: 'Me', name: 'Helm', reason: '' })).toBe('Hi Me, this is Helm.');
  });
  it('maskOtp hides standalone codes only', () => {
    expect(maskOtp('Your code is 482913, ref A12')).toBe('Your code is ••••••, ref A12');
  });
  it('findContact picks the most specific match', () => {
    expect(findContact('+61299812345', cfg())?.label).toBe('Office');
    expect(findContact('+61291234567', cfg())).toBeNull();
  });
});
