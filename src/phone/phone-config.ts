/**
 * Phone line (telefony-app over PhAP) settings and the single policy decision
 * every call/SMS action passes through. Pure: no I/O, no clock of its own.
 *
 * Two layers enforce: telefony-app's allowlist (exact numbers, outbound only)
 * and this policy (per-action, per-number, rate limits, quiet hours). The
 * generated allowlist is derived from these contacts, so a Helm bug can narrow
 * access but never widen it past what telefony itself permits.
 */

export type PhoneAction = 'call.in' | 'call.out' | 'sms.in' | 'sms.out' | 'sms.read' | 'conf.add';
export type PhoneRole = 'owner' | 'trusted';

export interface PhoneContact {
  label: string;
  /** E.164, national (0…) or a prefix ending in `*`. */
  pattern: string;
  role: PhoneRole;
  callIn: boolean;
  callOut: boolean;
  smsIn: boolean;
  smsOut: boolean;
  conf: boolean;
  /**
   * Keypad PIN (4-12 digits, then #) an inbound call from this number enters to
   * be verified; caller ID alone can be spoofed. '' = caller ID is enough for the
   * owner, and a trusted contact stays unverified.
   */
  pin: string;
  /** Receives messages a stranger leaves without naming anyone. */
  messages: boolean;
}

export interface PhoneLineConfig {
  enabled: boolean;
  /** telefony-app console script, e.g. `<repo>/.venv/Scripts/telefony-app.exe`. */
  executable: string;
  transport: string;
  port: number;
  token: string;
  heartbeatS: number;
  watchdog: boolean;
  ringFallback: 'ring' | 'reject';
  ringTimeoutS: number;
  countryCode: string;
  masters: { callIn: boolean; callOut: boolean; smsIn: boolean; smsOut: boolean; conference: boolean };
  contacts: PhoneContact[];
  smsRead: { scope: 'received' | 'window' | 'all' | 'none'; windowMin: number; maskOtp: boolean };
  /**
   * Regexes; a number matching any one (as E.164 `+61…` or national `0…`) is
   * refused every call and SMS, in and out, whoever asks.
   */
  blocklist: string[];
  limits: { callsPerHour: number; smsPerHour: number; maxCallMin: number; quietStart: string; quietEnd: string };
  persona: {
    name: string;
    greetIn: boolean;
    greetInText: string;
    greetOut: boolean;
    greetOutText: string;
    discloseAi: boolean;
    signSms: boolean;
  };
  voice: { tts: 'auto' | 'piper' | 'sapi' | 'none'; piperModel: string; sttModel: string };
  transcripts: {
    enabled: boolean;
    /** Empty = the Helm user-data dir. */
    folder: string;
    fileName: string;
    format: 'md' | 'json' | 'both';
    retentionDays: number;
  };
  conference: { maxParticipants: number; announce: boolean };
  /** When the Helm phone app is offline: ring_user dials the owner, notify_user texts them. */
  fallback: { ring: boolean; notify: boolean };
  /** The API tool (CLI type id) whose model runs call agents; empty = no call agents. */
  callAgentModel: string;
}

/** telefony-app's GitHub repo: the installer's source, and the manual-download link in Settings. */
export const TELEFONY_REPO = 'PetePeter/telefony-app';
export const TELEFONY_RELEASES_PAGE = `https://github.com/${TELEFONY_REPO}/releases`;

export const DEFAULT_PHONE_LINE_CONFIG: PhoneLineConfig = {
  enabled: false,
  executable: '',
  transport: '',
  port: 7781,
  token: '',
  heartbeatS: 10,
  watchdog: true,
  ringFallback: 'ring',
  ringTimeoutS: 15,
  countryCode: '+61',
  masters: { callIn: true, callOut: true, smsIn: true, smsOut: true, conference: false },
  contacts: [],
  smsRead: { scope: 'window', windowMin: 30, maskOtp: true },
  limits: { callsPerHour: 3, smsPerHour: 10, maxCallMin: 15, quietStart: '', quietEnd: '' },
  blocklist: [],
  persona: {
    name: 'Helm',
    greetIn: true,
    greetInText: "Hi {caller}, it's {name}. What do you need?",
    greetOut: true,
    greetOutText: 'Hi {caller}, this is {name}. {reason}',
    discloseAi: true,
    signSms: false,
  },
  voice: { tts: 'auto', piperModel: '', sttModel: '' },
  transcripts: { enabled: true, folder: '', fileName: '{yyyy}/{mm}/{yyyy}-{mm}-{dd}_{HHmm}_{label}_{direction}', format: 'md', retentionDays: 90 },
  conference: { maxParticipants: 3, announce: true },
  fallback: { ring: true, notify: false },
  callAgentModel: '',
};

/** Deep-merge a partial (e.g. parsed YAML) over the defaults; unknown keys are dropped. */
export function resolvePhoneLineConfig(raw: unknown): PhoneLineConfig {
  const src = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const d = DEFAULT_PHONE_LINE_CONFIG;
  const pick = <T extends object>(def: T, v: unknown): T => {
    const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
    const out = { ...def } as Record<string, unknown>;
    for (const k of Object.keys(def)) if (typeof o[k] === typeof (def as Record<string, unknown>)[k]) out[k] = o[k];
    return out as T;
  };
  const base = pick({ ...d, masters: undefined, contacts: undefined, fallback: undefined, smsRead: undefined, limits: undefined, persona: undefined, voice: undefined, transcripts: undefined, conference: undefined } as unknown as PhoneLineConfig, src);
  const validPin = (pin: unknown) => (typeof pin === 'string' && /^\d{4,12}$/.test(pin) ? pin : '');
  // Before per-contact PINs there was one `ownerPin`; it belongs to the owner row.
  const legacyOwnerPin = validPin(src.ownerPin);
  const rows = Array.isArray(src.contacts)
    ? src.contacts.map((raw) => {
      const c = pick<PhoneContact>({ label: '', pattern: '', role: 'trusted', callIn: false, callOut: false, smsIn: false, smsOut: false, conf: false, pin: '', messages: false }, raw);
      // Rows saved before the switch existed: the owner gets general messages.
      return typeof (raw as Record<string, unknown> | null)?.messages === 'boolean' ? c : { ...c, messages: c.role === 'owner' };
    })
      // Rows with no number yet stay (the user is still typing); they never match anything.
      .filter((c) => ['owner', 'trusted', 'blocked'].includes(c.role as string))
    : [];
  // Blocked used to be a contact role; those rows now live in the block list.
  const legacyBlocks = rows.filter((c) => (c.role as string) === 'blocked').map((c) => patternToRegex(c.pattern, (base.countryCode as string)))
    .filter((r): r is string => r !== null);
  const contacts = rows.filter((c) => (c.role as string) !== 'blocked')
    // Owner rights belong to one number, never a whole prefix.
    .map((c) => (c.role === 'owner' && c.pattern.trim().endsWith('*') ? { ...c, role: 'trusted' as const } : c))
    .map((c) => ({ ...c, pin: validPin(c.pin) || (c.role === 'owner' ? legacyOwnerPin : '') }));
  // So did the short-lived `limits.blockedPrefixes` (cost prefixes).
  const legacyPrefixes = ((src.limits as { blockedPrefixes?: unknown } | undefined)?.blockedPrefixes);
  if (Array.isArray(legacyPrefixes)) {
    for (const p of legacyPrefixes) {
      const re = typeof p === 'string' ? patternToRegex(`${p.replace(/\*$/, '')}*`, base.countryCode as string) : null;
      if (re) legacyBlocks.push(re);
    }
  }
  const blocklist = [...(Array.isArray(src.blocklist) ? src.blocklist : []), ...legacyBlocks]
    .filter((r): r is string => typeof r === 'string' && r.trim() !== '' && compiles(r));
  return {
    ...base,
    masters: pick(d.masters, src.masters),
    contacts,
    blocklist: [...new Set(blocklist)],
    smsRead: pick(d.smsRead, src.smsRead),
    limits: pick(d.limits, src.limits),
    persona: pick(d.persona, src.persona),
    voice: pick(d.voice, src.voice),
    transcripts: pick(d.transcripts, src.transcripts),
    conference: pick(d.conference, src.conference),
    fallback: pick(d.fallback, src.fallback),
  };
}

/**
 * Normalise to `+<digits>`, reading national numbers (leading 0) with the
 * country code. Returns null for withheld/private or anything with characters
 * that are not part of a phone number.
 */
export function normalizeNumber(raw: string, countryCode: string): string | null {
  const s = raw.trim().replace(/[\s\-().]/g, '');
  if (!/^\+?\d{3,}$/.test(s)) return null;
  if (s.startsWith('+')) return s;
  if (s.startsWith('00')) return `+${s.slice(2)}`;
  if (s.startsWith('0')) return `${countryCode}${s.slice(1)}`;
  if (NO_TRUNK_PREFIX[countryCode]?.test(s)) return `${countryCode}${s}`;
  return `+${s}`;
}

/** National numbers dialled without a leading 0 (Australia's 13 / 1300 / 1800 / 19xx). */
const NO_TRUNK_PREFIX: Record<string, RegExp | undefined> = { '+61': /^1[389]\d{4,8}$/ };

interface Match { contact: PhoneContact; specificity: number }

function matchContacts(number: string, cfg: PhoneLineConfig): Match[] {
  const out: Match[] = [];
  for (const contact of cfg.contacts) {
    const p = contact.pattern.trim();
    if (p.endsWith('*')) {
      const prefix = normalizeNumber(p.slice(0, -1), cfg.countryCode);
      if (prefix && number.startsWith(prefix)) out.push({ contact, specificity: prefix.length });
    } else {
      const exact = normalizeNumber(p, cfg.countryCode);
      if (exact === number) out.push({ contact, specificity: Number.MAX_SAFE_INTEGER });
    }
  }
  return out.sort((a, b) => b.specificity - a.specificity);
}

/** The contact a number resolves to (most specific match), ignoring permissions. */
export function findContact(raw: string, cfg: PhoneLineConfig): PhoneContact | null {
  const n = normalizeNumber(raw, cfg.countryCode);
  return n ? matchContacts(n, cfg)[0]?.contact ?? null : null;
}

export function ownerContact(cfg: PhoneLineConfig): PhoneContact | null {
  return cfg.contacts.find((c) => c.role === 'owner' && !c.pattern.includes('*')) ?? null;
}

export interface DecideContext {
  now: Date;
  /** Outbound actions already taken in the last hour. */
  callsLastHour: number;
  smsLastHour: number;
  /** Live conference size including Helm, for conf.add. */
  participants?: number;
  /** ring_user to the owner may ring through quiet hours. */
  urgent?: boolean;
}

export type Decision =
  | { allow: true; contact: PhoneContact; number: string }
  | { allow: false; reason: string };

const MASTER: Record<PhoneAction, (m: PhoneLineConfig['masters']) => boolean> = {
  'call.in': (m) => m.callIn,
  'call.out': (m) => m.callOut,
  'sms.in': (m) => m.smsIn,
  'sms.out': (m) => m.smsOut,
  'sms.read': (m) => m.smsIn,
  'conf.add': (m) => m.conference && m.callOut,
};

const PER_CONTACT: Record<PhoneAction, (c: PhoneContact) => boolean> = {
  'call.in': (c) => c.callIn,
  'call.out': (c) => c.callOut,
  'sms.in': (c) => c.smsIn,
  'sms.out': (c) => c.smsOut,
  'sms.read': (c) => c.smsIn,
  'conf.add': (c) => c.conf,
};

function minutesOf(hhmm: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

export function inQuietHours(cfg: PhoneLineConfig, now: Date): boolean {
  const start = minutesOf(cfg.limits.quietStart);
  const end = minutesOf(cfg.limits.quietEnd);
  if (start === null || end === null || start === end) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return start < end ? t >= start && t < end : t >= start || t < end;
}

function compiles(re: string): boolean {
  try { new RegExp(re); return true; } catch { return false; }
}

/** An old contact pattern (exact number, or prefix ending `*`) as a block-list regex. */
function patternToRegex(pattern: string, countryCode: string): string | null {
  const p = pattern.trim();
  const prefix = p.endsWith('*');
  const n = normalizeNumber(prefix ? p.slice(0, -1) : p, countryCode);
  return n ? `^${n.replace('+', '\\+')}${prefix ? '' : '$'}` : null;
}

/** True when the number matches the block list, as E.164 or in national form. */
export function isBlocked(number: string, cfg: PhoneLineConfig): boolean {
  // E.164 is at most 15 digits. Longer input is refused outright, which also
  // bounds how long a badly written user regex can backtrack.
  if (number.length > 16) return true;
  const national = number.startsWith(cfg.countryCode) ? `0${number.slice(cfg.countryCode.length)}` : null;
  return cfg.blocklist.some((re) => {
    const rx = new RegExp(re);
    return rx.test(number) || (national !== null && rx.test(national));
  });
}

/** Premium-rate ranges that settings cannot unblock. */
const BUILT_IN_PREMIUM: Record<string, string[] | undefined> = { '+61': ['+6119'] };

/**
 * Numbers that cost money are refused for everyone, the owner included: a
 * talked-into-it assistant must not be able to run up a bill. International is
 * anything outside the home country code; `0011` is the Australian exit prefix,
 * which `normalizeNumber` would otherwise read as a national number.
 */
function costBlock(rawNumber: string, number: string, cfg: PhoneLineConfig): string | null {
  // Premium ranges are only known for these countries; anything else (or a
  // typo such as "+6") would make the checks meaningless, so fail closed.
  if (!BUILT_IN_PREMIUM[cfg.countryCode]) return 'outbound needs a supported country code setting (+61)';
  if (/^\s*0011/.test(rawNumber) || !number.startsWith(cfg.countryCode)) return 'international numbers are blocked';
  const premium = BUILT_IN_PREMIUM[cfg.countryCode]!.some((p) => {
    const prefix = normalizeNumber(p.replace(/\*$/, ''), cfg.countryCode);
    return prefix !== null && number.startsWith(prefix);
  });
  return premium ? 'premium numbers are blocked' : null;
}

/**
 * Dial-out for a caller on the line ("call this number for me"): any number
 * goes, but only for a PIN-verified caller, never a costly number, and within
 * the hourly call cap. A blocked entry still wins.
 */
export function decideDialOut(
  rawNumber: string, cfg: PhoneLineConfig, ctx: { verified: boolean; callsLastHour: number },
): { allow: true; number: string } | { allow: false; reason: string } {
  if (!cfg.masters.callOut) return { allow: false, reason: 'call.out is switched off' };
  if (!ctx.verified) return { allow: false, reason: 'only a caller who entered their PIN can dial out' };
  const number = normalizeNumber(rawNumber, cfg.countryCode);
  if (!number) return { allow: false, reason: 'withheld or invalid number' };
  const cost = costBlock(rawNumber, number, cfg);
  if (cost) return { allow: false, reason: cost };
  if (isBlocked(number, cfg)) return { allow: false, reason: 'blocked' };
  if (ctx.callsLastHour >= cfg.limits.callsPerHour) return { allow: false, reason: 'hourly call limit reached' };
  return { allow: true, number };
}

/** Every phone action is allowed or denied here, in a fixed order. */
export function decide(action: PhoneAction, rawNumber: string, cfg: PhoneLineConfig, ctx: DecideContext): Decision {
  if (!MASTER[action](cfg.masters)) return { allow: false, reason: `${action} is switched off` };
  const number = normalizeNumber(rawNumber, cfg.countryCode);
  if (!number) return { allow: false, reason: 'withheld or invalid number' };
  if (isBlocked(number, cfg)) return { allow: false, reason: 'blocked' };
  const matches = matchContacts(number, cfg);
  const contact = matches[0]?.contact;
  if (!contact) return { allow: false, reason: 'not listed' };
  if (!PER_CONTACT[action](contact)) return { allow: false, reason: `${action} is off for ${contact.label || 'this number'}` };

  const outbound = action === 'call.out' || action === 'sms.out' || action === 'conf.add';
  if (outbound) {
    const cost = costBlock(rawNumber, number, cfg);
    if (cost) return { allow: false, reason: cost };
    if (inQuietHours(cfg, ctx.now) && !(ctx.urgent && contact.role === 'owner')) return { allow: false, reason: 'quiet hours' };
    if (action !== 'sms.out' && ctx.callsLastHour >= cfg.limits.callsPerHour) return { allow: false, reason: 'hourly call limit reached' };
    if (action === 'sms.out' && ctx.smsLastHour >= cfg.limits.smsPerHour) return { allow: false, reason: 'hourly SMS limit reached' };
  }
  if (action === 'conf.add' && (ctx.participants ?? 2) >= cfg.conference.maxParticipants) {
    return { allow: false, reason: 'conference is full' };
  }
  return { allow: true, contact, number };
}

/** Fill `{token}` placeholders; unknown tokens are left as-is. */
export function fillTemplate(template: string, values: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (all, key: string) => (key in values ? values[key] : all)).replace(/\s+/g, ' ').trim();
}

/** OTP-looking codes (4–8 digits standing alone) masked, for inbox reads. */
export function maskOtp(text: string): string {
  return text.replace(/\b\d{4,8}\b/g, (d) => '•'.repeat(d.length));
}
