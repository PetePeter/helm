/**
 * Reception — answers a caller who is not in the contact list, in plain code.
 *
 * No model ever reads a stranger's words: the isolation model (artifact
 * 303a8fd6) keeps raw third-party text away from anything holding tools. The
 * caller either names a contact (a word match, never a lookup they can see) or
 * leaves a message, which goes by SMS to people — readers with no tools.
 * Nothing spoken ever names a contact the caller did not name first.
 */
import type { PhoneContact, PhoneLineConfig } from './phone-config.js';

/** What Reception may do to its one call. The bridge binds it to the callId. */
export interface ReceptionPort {
  say(text: string): Promise<void>;
  hold(): Promise<void>;
  resume(): Promise<void>;
  conference(contact: PhoneContact): Promise<void>;
  sms(contact: PhoneContact, text: string): Promise<void>;
  hangup(): Promise<void>;
}

export interface ReceptionDeps {
  /** The caller's number as telefony reported it, or "withheld". */
  caller: string;
  getConfig: () => PhoneLineConfig;
  port: ReceptionPort;
  /** How long a named contact has to answer the hold text. */
  holdMs?: number;
}

const HOLD_MS = 2 * 60_000;
const MAX_MESSAGE_CHARS = 600;
const words = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}']+/gu) ?? [];

/**
 * The contact a caller asked for: the full label, or its first word, as words
 * in what they said. Only owner/trusted rows taking calls; an ambiguous first
 * name matches nobody rather than the wrong person.
 */
export function matchContactByName(text: string, cfg: PhoneLineConfig): PhoneContact | null {
  const said = ` ${words(text).join(' ')} `;
  const rows = cfg.contacts.filter((c) => c.role !== 'blocked' && c.callIn && words(c.label).length > 0);
  const full = rows.filter((c) => said.includes(` ${words(c.label).join(' ')} `));
  if (full.length === 1) return full[0];
  const first = rows.filter((c) => said.includes(` ${words(c.label)[0]} `));
  return first.length === 1 ? first[0] : null;
}

type Stage = 'ask' | 'holding' | 'message' | 'joined';

export class Reception {
  private stage: Stage = 'ask';
  /** Who the message is for; null = the general-message list. */
  private target: PhoneContact | null = null;
  private message: string[] = [];
  private holdTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: ReceptionDeps) {}

  async onAnswered(): Promise<void> {
    const name = this.deps.getConfig().persona.name;
    await this.deps.port.say(`Hello, you've reached ${name}. Who would you like to speak to? Or say message to leave one.`);
  }

  async onUtterance(text: string): Promise<void> {
    const said = text.trim();
    if (!said) return;
    if (this.stage === 'message') { this.message.push(said); return; }
    if (this.stage !== 'ask') return;
    if (words(said).includes('message')) return this.takeMessage('Go ahead, then hang up when you are done.');
    const contact = matchContactByName(said, this.deps.getConfig());
    if (!contact) return this.takeMessage("Sorry, that person isn't available here. Please leave a message, then hang up.");
    this.stage = 'holding';
    this.target = contact;
    await this.deps.port.say('Please hold while I check.');
    await this.deps.port.hold();
    await this.deps.port.sms(contact, `Someone (${this.callerText()}) is calling for you. Reply JOIN to take the call, or text a message to pass on.`);
    // The SMS poll runs outside the call-event queue: the answer may already be in.
    if (this.stage !== 'holding') return;
    this.holdTimer = setTimeout(() => {
      this.holdTimer = null;
      if (!this.claimHold('message')) return;
      void this.unhold().then(() => this.deps.port.say("They didn't answer. Please leave a message, then hang up."));
    }, this.deps.holdMs ?? HOLD_MS);
  }

  /** An SMS from a contact while this call runs. True when it was the answer we were waiting for. */
  async onSmsFrom(contact: PhoneContact, text: string): Promise<boolean> {
    if (this.stage !== 'holding' || contact.pattern !== this.target?.pattern) return false;
    const join = text.trim().toUpperCase() === 'JOIN';
    this.claimHold(join ? 'joined' : 'message');
    await this.unhold();
    if (!join) {
      await this.deps.port.say(`They say: ${text.trim()}. You can leave a reply now, or hang up.`);
      return true;
    }
    try {
      await this.deps.port.conference(contact);
    } catch {
      await this.takeMessage("Sorry, I couldn't connect you. Please leave a message, then hang up.");
    }
    return true;
  }

  /**
   * Leave the hold, synchronously, so the answer and the timeout can never both
   * act on it. False when the other one got there first.
   */
  private claimHold(next: Stage): boolean {
    if (this.stage !== 'holding') return false;
    this.stage = next;
    this.clearHold();
    return true;
  }

  /** The call is over: deliver what the caller left. */
  async onEnded(): Promise<void> {
    this.clearHold();
    const body = this.message.join(' ').slice(0, MAX_MESSAGE_CHARS);
    if (!body) return;
    const text = `Message from ${this.callerText()}: ${body}`;
    const to = this.target ? [this.target] : this.deps.getConfig().contacts.filter((c) => c.messages);
    for (const c of to) await this.deps.port.sms(c, text).catch(() => undefined);
  }

  private async takeMessage(line: string): Promise<void> {
    this.stage = 'message';
    await this.deps.port.say(line);
  }

  private async unhold(): Promise<void> {
    await this.deps.port.resume().catch(() => undefined);
  }

  private clearHold(): void {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }

  private callerText(): string {
    return /^\+?\d{3,}$/.test(this.deps.caller) ? this.deps.caller : 'a withheld number';
  }
}
