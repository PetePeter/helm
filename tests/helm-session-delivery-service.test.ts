/**
 * HelmSessionDeliveryService tests — envelope framing and text delivery.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { HelmSessionDeliveryService } from '../src/mcp/services/helm-session-delivery-service.js';
import { buildHelmMsgDirective } from '../src/session/intersession-directive.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('../src/utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeSession(overrides?: Partial<{ id: string; name: string; cliType: string }>) {
  return {
    id: overrides?.id ?? 'recv-session',
    name: overrides?.name ?? 'RecvSession',
    cliType: overrides?.cliType ?? 'claude-code',
  };
}

function makeDeps(opts?: { helmPreambleForInterSession?: boolean; largeTextAsTempFile?: boolean; clearCommand?: string; receiverSession?: ReturnType<typeof makeSession>; ptyRunning?: boolean }) {
  const receiver = opts?.receiverSession ?? makeSession();
  const sender = makeSession({ id: 'sender-session', name: 'SenderSession' });

  const capturedTexts: string[] = [];

  const sessionManager = {
    getAllSessions: vi.fn(() => [receiver, sender]),
    getSession: vi.fn((id: string) => {
      if (id === receiver.id) return receiver;
      if (id === sender.id) return sender;
      return null;
    }),
  };

  const ptyManager = {
    has: vi.fn(() => opts?.ptyRunning ?? true),
    write: vi.fn(),
    // Parameters are spelled out so assertions on mock.calls stay typed.
    deliverText: vi.fn(async (_sessionId: string, _text: string, _options?: unknown) => {}),
    nudgeResize: vi.fn(async () => {}),
  };

  const configLoader = {
    getCliTypeEntry: vi.fn(() => ({
      helmPreambleForInterSession: opts?.helmPreambleForInterSession ?? true,
      largeTextAsTempFile: opts?.largeTextAsTempFile,
      clearCommand: opts?.clearCommand,
      submitSuffix: '\\r',
    })),
  };

  const service = new HelmSessionDeliveryService(
    sessionManager as any,
    ptyManager as any,
    configLoader as any,
  );

  return { service, sessionManager, ptyManager, configLoader, receiver, sender, capturedTexts };
}

function getSentText(ptyManager: ReturnType<typeof makeDeps>['ptyManager']): string {
  // deliverText is called for each chunk; find the first non-empty chunk (the message body)
  const calls = ptyManager.deliverText.mock.calls;
  const textCall = calls.find((c: any[]) => c[1] && c[2] === undefined);
  return textCall ? textCall[1] : '';
}

describe('HelmSessionDeliveryService', () => {
  it('delivers system reminders without a sender envelope and with system intent', async () => {
    const { service, ptyManager, receiver } = makeDeps({ helmPreambleForInterSession: true });

    await service.sendSystemReminder(receiver.id, '[HELM_MESS] 3 new — call mess_check');

    expect(ptyManager.deliverText).toHaveBeenCalledWith(
      receiver.id,
      '[HELM_MESS] 3 new — call mess_check',
      expect.objectContaining({ deliveryContext: 'background', writeIntent: 'system' }),
    );
  });

  describe('envelope framing (preamble=true)', () => {
    /**
     * The envelope, the user text and the directive used to be separated by
     * {Wait 80} tokens, which the sequence executor turns into three separate
     * PTY writes — three bracketed pastes into the recipient's composer, and
     * three chances for a full-screen TUI to still be mid-ingest when the Enter
     * arrives. The bytes were always glued together anyway, so one write says
     * the same thing with one race instead of three.
     */
    it('delivers tag, envelope, user text and directive as a single write', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();

      await service.sendTextToSession(receiver.id, 'hello world', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
        expectsResponse: false,
      });

      const textCalls = ptyManager.deliverText.mock.calls.filter((c: any[]) => c[1]);
      expect(textCalls).toHaveLength(1);

      const sent = textCalls[0][1] as string;
      expect(sent.indexOf('[HELM_MSG]')).toBe(0);
      // Envelope JSON, then the user text, then the directive — in that order.
      const envelopeEnd = sent.indexOf('}') + 1;
      expect(sent.slice(0, envelopeEnd)).not.toContain('\n');
      expect(sent.indexOf('hello world')).toBe(envelopeEnd);
      expect(sent.indexOf('[HELM_MSG_RULES]')).toBeGreaterThan(sent.indexOf('hello world'));
    });

    it('user text containing a literal \\n is preserved unchanged', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      const userText = 'line one\nline two';

      await service.sendTextToSession(receiver.id, userText, {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
        expectsResponse: false,
      });

      const sent = ptyManager.deliverText.mock.calls.find((c: any[]) => c[1])?.[1] as string;
      // The payload newline must survive intact
      expect(sent).toContain('line one\nline two');
    });
  });

  describe('non-blocking recipient directive', () => {
    function allDeliveredText(ptyManager: ReturnType<typeof makeDeps>['ptyManager']): string {
      return ptyManager.deliverText.mock.calls.map((c: any[]) => c[1] ?? '').join('\n');
    }

    it('tells fire-and-forget recipients not to use AskUserQuestion', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();

      await service.sendTextToSession(receiver.id, 'do the thing', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
        expectsResponse: false,
      });

      expect(allDeliveredText(ptyManager)).toContain('AskUserQuestion');
    });

    it('keeps the reply-routing instruction alongside the directive when expectsResponse=true', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();

      await service.sendTextToSession(receiver.id, 'what branch?', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
        expectsResponse: true,
      });

      const all = allDeliveredText(ptyManager);
      expect(all).toContain('expectsResponse=true');
      expect(all).toContain('AskUserQuestion');
    });

    it('names session_send_text and the sender id as the question channel', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();

      await service.sendTextToSession(receiver.id, 'ambiguous task', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      const all = allDeliveredText(ptyManager);
      expect(all).toContain('session_send_text');
      expect(all).toContain(sender.id);
    });

    it('instructs the recipient to stand by rather than assume', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();

      await service.sendTextToSession(receiver.id, 'ambiguous task', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      const all = allDeliveredText(ptyManager);
      expect(all).toContain('stand by');
      expect(all).toContain('session_set_aiagent_state');
    });

    it('carries the same directive for a cross-machine fleet sender address', async () => {
      const { service, ptyManager, receiver } = makeDeps();
      const fleetSender = 'fleet:peer-abc:remote-session-1';

      await service.sendTextToSession(receiver.id, 'remote task', {
        senderSessionId: fleetSender,
        senderSessionName: 'RemoteMac',
      });

      const all = allDeliveredText(ptyManager);
      expect(all).toContain('AskUserQuestion');
      expect(all).toContain(fleetSender);
    });

    /**
     * A phone is not a session. `mobile:<deviceId>` is a synthetic proxy
     * identity (docs/mobile-gate.md) that session_send_text cannot resolve, so
     * pointing a recipient at it guaranteed "Session not found" on every reply.
     * The phone's own surface is chat_send, exactly as Telegram mode routes
     * replies through telegram_chat.
     */
    it('routes a phone sender to chat_send instead of an unresolvable address', async () => {
      const { service, ptyManager, receiver } = makeDeps();
      const phoneSender = 'mobile:008a8ddd-1c4a-4f5e-9a2b-000000000000';

      await service.sendTextToSession(receiver.id, 'from my phone', {
        senderSessionId: phoneSender,
        senderSessionName: 'ThinkPhone',
      });

      const all = allDeliveredText(ptyManager);
      expect(all).toContain('chat_send');
      expect(all).toContain('AskUserQuestion');
      // The directive must never hand the mobile address to session_send_text.
      expect(all).not.toContain(`sessionId="${phoneSender}"`);
      expect(all).not.toContain('session_send_text');
    });

    it('routes a phone sender to chat_send in the expectsResponse tag too', async () => {
      const { service, ptyManager, receiver } = makeDeps();
      const phoneSender = 'mobile:008a8ddd-1c4a-4f5e-9a2b-000000000000';

      await service.sendTextToSession(receiver.id, 'what branch?', {
        senderSessionId: phoneSender,
        senderSessionName: 'ThinkPhone',
        expectsResponse: true,
      });

      const all = allDeliveredText(ptyManager);
      expect(all).toContain('expectsResponse=true');
      expect(all).toContain('chat_send');
      expect(all).not.toContain('session_send_text');
    });

    /**
     * Provenance is not routing: the envelope still records which phone sent the
     * message, it just stops being advertised as a reply address.
     */
    /**
     * Observed 2026-09-17: phone-originated turns ended with interim updates
     * written to the terminal only — the phone user had to ask "reply to
     * mobile!". For a phone sender the directive's FIRST rule is the output
     * channel itself: terminal output is invisible there, and every message
     * gets a chat_send reply, not just questions.
     */
    it('leads the phone directive with a mandatory chat_send-for-every-reply rule', async () => {
      const { service, ptyManager, receiver } = makeDeps();
      const phoneSender = 'mobile:008a8ddd-1c4a-4f5e-9a2b-000000000000';

      await service.sendTextToSession(receiver.id, 'how is it going?', {
        senderSessionId: phoneSender,
        senderSessionName: 'ThinkPhone',
      });

      const all = allDeliveredText(ptyManager);
      const rulesStart = all.indexOf('[HELM_MSG_RULES]\n');
      expect(rulesStart).toBeGreaterThanOrEqual(0);
      const firstRule = all.slice(rulesStart).split('\n')[1];
      expect(firstRule).toContain('chat_send');
      expect(firstRule).toContain('invisible');
    });

    it('keeps the channel rule out of peer and local sender directives', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();

      await service.sendTextToSession(receiver.id, 'how is it going?', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      const all = allDeliveredText(ptyManager);
      expect(all).not.toContain('invisible');
      // Peer reply routing is unchanged: still session_send_text.
      expect(all).toContain('session_send_text');
      expect(all).toContain(`sessionId="${sender.id}"`);
    });

    it('keeps the phone address in the envelope as provenance', async () => {
      const { service, ptyManager, receiver } = makeDeps();
      const phoneSender = 'mobile:008a8ddd-1c4a-4f5e-9a2b-000000000000';

      await service.sendTextToSession(receiver.id, 'from my phone', {
        senderSessionId: phoneSender,
        senderSessionName: 'ThinkPhone',
      });

      const sent = ptyManager.deliverText.mock.calls.find((c: any[]) => String(c[1]).startsWith('[HELM_MSG'))?.[1] as string;
      const envelopeText = sent.slice(sent.indexOf('{'));
      const envelope = JSON.parse(envelopeText.slice(0, envelopeText.indexOf('}') + 1));
      expect(envelope.fromSessionId).toBe(phoneSender);
      expect(envelope.fromSessionName).toBe('ThinkPhone');
    });

    it('omits the directive for recipients that opted out of the preamble', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps({ helmPreambleForInterSession: false });

      await service.sendTextToSession(receiver.id, 'plain message', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      expect(allDeliveredText(ptyManager)).not.toContain('AskUserQuestion');
    });

    it('omits the prepended directive when the recipient injects rules via hooks (G4 dual-path)', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      service.setReminderDelivery(async (_session, reminder) => (
        reminder === 'helmMsgRules' ? { channel: 'hook', fellBack: false } : { channel: 'pty', fellBack: false }
      ));

      await service.sendTextToSession(receiver.id, 'do the thing', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      const sent = allDeliveredText(ptyManager);
      // The rules travel out-of-band instead — the hook injects them.
      expect(sent).toContain('[HELM_MSG]');
      expect(sent).toContain('do the thing');
      expect(sent).not.toContain('[HELM_MSG_RULES]');
    });

    it('keeps prepending the directive when the recipient has no hooks installed', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      service.setReminderDelivery(async () => ({ channel: 'pty', fellBack: true }));

      await service.sendTextToSession(receiver.id, 'do the thing', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      expect(allDeliveredText(ptyManager)).toContain('[HELM_MSG_RULES]');
    });

    /**
     * G9: mode pty is the user's choice — it prepends even when the recipient
     * COULD inject, because the visible setting must mean what it says.
     */
    it('mode pty prepends the directive even for a hook-capable recipient', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      service.setReminderDelivery(async () => ({ channel: 'pty', fellBack: false }));

      await service.sendTextToSession(receiver.id, 'do the thing', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      expect(allDeliveredText(ptyManager)).toContain('[HELM_MSG_RULES]');
    });

    /** G9: off suppresses the reminder on both paths — the message still lands. */
    it('mode off sends the envelope and text with no directive at all', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      service.setReminderDelivery(async () => ({ channel: 'off', fellBack: false }));

      await service.sendTextToSession(receiver.id, 'do the thing', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      const sent = allDeliveredText(ptyManager);
      expect(sent).toContain('[HELM_MSG]');
      expect(sent).toContain('do the thing');
      expect(sent).not.toContain('[HELM_MSG_RULES]');
      expect(sent).not.toContain('AskUserQuestion');
    });

    /**
     * The zero-change pin: with no resolver wired (and for every session whose
     * resolved channel is pty — which is every session without hooks), the
     * delivered bytes are EXACTLY today's framing, directive included.
     */
    it('a pty-channel recipient gets the directive byte-identical to the builder output', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      service.setReminderDelivery(async () => ({ channel: 'pty', fellBack: true }));

      await service.sendTextToSession(receiver.id, 'byte for byte', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
        expectsResponse: false,
      });

      const sent = allDeliveredText(ptyManager);
      const expectedDirective = buildHelmMsgDirective(sender.id);
      // The builder's exact bytes ride in the message, after the user text.
      expect(sent).toContain('byte for byte' + expectedDirective);
    });

    it('prepends as always when no capability check is wired at all', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      await service.sendTextToSession(receiver.id, 'do the thing', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });
      expect(allDeliveredText(ptyManager)).toContain('[HELM_MSG_RULES]');
    });
  });

  describe('plain delivery (preamble=false)', () => {
    it('sends user text without any [HELM_MSG] wrapper', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps({ helmPreambleForInterSession: false });

      await service.sendTextToSession(receiver.id, 'plain message', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });

      const sent = getSentText(ptyManager);
      expect(sent).toBe('plain message');
      expect(sent).not.toContain('[HELM_MSG]');
    });
  });

  describe('large text temp file handoff', () => {
    it('writes large session_send_text payloads to a temp file when enabled', async () => {
      const oldThreshold = process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD;
      const oldAppData = process.env.APPDATA;
      const oldHome = process.env.HOME;
      const tempHome = mkdtempSync(join(tmpdir(), 'helm-large-text-'));
      process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD = '10';
      process.env.APPDATA = tempHome;
      process.env.HOME = tempHome;

      try {
        const { service, ptyManager, receiver, sender } = makeDeps({ largeTextAsTempFile: true });
        const result = await service.sendTextToSession(receiver.id, 'this is a large payload', {
          senderSessionId: sender.id,
          senderSessionName: sender.name,
        });

        expect(result.ok).toBe(true);
        // payloadRef removed from envelope — path lives only in the preamble notice
        const envelopeCall = ptyManager.deliverText.mock.calls.find((c: any[]) => String(c[1]).startsWith('[HELM_MSG]'));
        // The envelope opens the single delivered chunk; the payload and the
        // directive follow it, so parse only up to the object's closing brace
        // (the envelope is a flat object — its first '}' is its last).
        const envelopeText = String(envelopeCall?.[1] ?? '').slice('[HELM_MSG]'.length);
        const envelope = JSON.parse(envelopeText.slice(0, envelopeText.indexOf('}') + 1));
        expect(envelope.payloadRef).toBeUndefined();
        const noticeCall = ptyManager.deliverText.mock.calls.find((c: any[]) => String(c[1]).includes('Read the full file at:'));
        const noticeText = String(noticeCall?.[1] ?? '');
        const pathLine = noticeText.split('\n').find((l) => l.startsWith('Read the full file at:'));
        const tempFilePath = pathLine?.slice('Read the full file at:'.length).trim() ?? '';
        expect(tempFilePath).toContain('helm-large-text-session-send-text');
        expect(readFileSync(tempFilePath, 'utf8')).toBe('this is a large payload');
        expect(noticeText).not.toContain('this is a large payload');
      } finally {
        if (oldThreshold === undefined) delete process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD;
        else process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD = oldThreshold;
        if (oldAppData === undefined) delete process.env.APPDATA;
        else process.env.APPDATA = oldAppData;
        if (oldHome === undefined) delete process.env.HOME;
        else process.env.HOME = oldHome;
        rmSync(tempHome, { recursive: true, force: true });
      }
    });
  });

  describe('clearSession', () => {
    const oldSettle = process.env.HELM_CLEAR_SETTLE_DELAY_MS;
    beforeEach(() => {
      process.env.HELM_CLEAR_SETTLE_DELAY_MS = '0';
    });
    afterEach(() => {
      if (oldSettle === undefined) delete process.env.HELM_CLEAR_SETTLE_DELAY_MS;
      else process.env.HELM_CLEAR_SETTLE_DELAY_MS = oldSettle;
    });

    function allDelivered(ptyManager: ReturnType<typeof makeDeps>['ptyManager']): string {
      return ptyManager.deliverText.mock.calls.map((c: any[]) => c[1] ?? '').join('|');
    }

    it('sends the default /clear command to the caller\'s own PTY', async () => {
      const { service, ptyManager, receiver } = makeDeps();
      await service.clearSession(receiver.id, { senderSessionId: receiver.id, senderSessionName: receiver.name });
      expect(allDelivered(ptyManager)).toContain('/clear');
    });

    it('self-target is allowed (no self-send rejection)', async () => {
      const { service, receiver } = makeDeps();
      const result = await service.clearSession(receiver.id, { senderSessionId: receiver.id, senderSessionName: receiver.name });
      expect(result.ok).toBe(true);
    });

    it('uses the per-cliType clearCommand override when configured', async () => {
      const { service, ptyManager, receiver } = makeDeps({ clearCommand: '/new' });
      await service.clearSession(receiver.id, { senderSessionId: receiver.id, senderSessionName: receiver.name });
      const delivered = allDelivered(ptyManager);
      expect(delivered).toContain('/new');
      expect(delivered).not.toContain('/clear');
    });

    it('does not relay any follow-up text when no context is given', async () => {
      const { service, ptyManager, receiver } = makeDeps();
      const result = await service.clearSession(receiver.id, { senderSessionId: receiver.id, senderSessionName: receiver.name });
      expect(result.contextRelayed).toBe(false);
      // Only the clear command chunks should have been delivered
      const nonEmpty = ptyManager.deliverText.mock.calls.map((c: any[]) => c[1]).filter((t: string) => t && t.trim());
      expect(nonEmpty.every((t: string) => t.includes('/clear'))).toBe(true);
    });

    it('relays context to the PTY after the clear', async () => {
      const { service, ptyManager, receiver } = makeDeps();
      const result = await service.clearSession(receiver.id, {
        senderSessionId: receiver.id,
        senderSessionName: receiver.name,
        context: 'remember: feature X is half done',
      });
      expect(result.contextRelayed).toBe(true);
      expect(allDelivered(ptyManager)).toContain('remember: feature X is half done');
    });

    it('writes a temp file and pastes a notice for large context', async () => {
      const oldThreshold = process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD;
      const oldAppData = process.env.APPDATA;
      const oldHome = process.env.HOME;
      const tempHome = mkdtempSync(join(tmpdir(), 'helm-clear-ctx-'));
      process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD = '10';
      process.env.APPDATA = tempHome;
      process.env.HOME = tempHome;
      try {
        const { service, ptyManager, receiver } = makeDeps({ largeTextAsTempFile: true });
        const result = await service.clearSession(receiver.id, {
          senderSessionId: receiver.id,
          senderSessionName: receiver.name,
          context: 'this is a large note to my future self',
        });
        expect(result.usedTempFile).toBe(true);
        const noticeCall = ptyManager.deliverText.mock.calls.find((c: any[]) => String(c[1]).includes('Read the full file at:'));
        const noticeText = String(noticeCall?.[1] ?? '');
        const pathLine = noticeText.split('\n').find((l) => l.startsWith('Read the full file at:'));
        const tempFilePath = pathLine?.slice('Read the full file at:'.length).trim() ?? '';
        expect(tempFilePath).toContain('helm-large-text-session-clear-context');
        expect(readFileSync(tempFilePath, 'utf8')).toBe('this is a large note to my future self');
        expect(noticeText).not.toContain('this is a large note to my future self');
      } finally {
        if (oldThreshold === undefined) delete process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD;
        else process.env.HELM_LARGE_TEXT_TEMP_FILE_THRESHOLD = oldThreshold;
        if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
        if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
        rmSync(tempHome, { recursive: true, force: true });
      }
    });

    it('throws when the session PTY is not running', async () => {
      const { service, receiver } = makeDeps({ ptyRunning: false });
      await expect(
        service.clearSession(receiver.id, { senderSessionId: receiver.id, senderSessionName: receiver.name }),
      ).rejects.toThrow('PTY is not running');
    });
  });

  describe('sendInputToSession', () => {
    it('rejects anonymous input (no sender)', async () => {
      const { service, receiver } = makeDeps();
      await expect(service.sendInputToSession(receiver.id, '{Esc}')).rejects.toThrow('anonymous input is not allowed');
    });

    it('rejects self-send', async () => {
      const { service, receiver } = makeDeps();
      await expect(
        service.sendInputToSession(receiver.id, '{Esc}', { senderSessionId: receiver.id, senderSessionName: receiver.name }),
      ).rejects.toThrow('Cannot send input from a session to itself');
    });

    it('sends sequence to PTY without HELM_MSG preamble', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      await service.sendInputToSession(receiver.id, '{Esc}{Tab}{Enter}', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });
      // Verify no HELM_MSG was written — check all deliverText calls
      const calls = ptyManager.deliverText.mock.calls;
      const allText = calls.map((c: any[]) => c[1] ?? '').join('');
      expect(allText).not.toContain('[HELM_MSG]');
    });

    it('defaults impliedSubmit to false', async () => {
      const { service, ptyManager, receiver, sender } = makeDeps();
      await service.sendInputToSession(receiver.id, 'hello', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });
      const calls = ptyManager.deliverText.mock.calls;
      // With impliedSubmit=false, only the text itself is sent — no submit suffix appended after it
      const textCalls = calls.filter((c: any[]) => c[1] === 'hello' && c[2] === undefined);
      expect(textCalls.length).toBeGreaterThanOrEqual(1);
    });

    it('returns success with sessionId and name', async () => {
      const { service, receiver, sender } = makeDeps();
      const result = await service.sendInputToSession(receiver.id, '{Esc}', {
        senderSessionId: sender.id,
        senderSessionName: sender.name,
      });
      expect(result.ok).toBe(true);
      expect(result.verified).toBeDefined();
    });
  });
});

describe('message flight gate (envelope animation before the paste)', () => {
  const ORIGINAL_TIMEOUT = process.env.HELM_MESSAGE_FLIGHT_TIMEOUT_MS;

  beforeEach(() => {
    process.env.HELM_MESSAGE_FLIGHT_TIMEOUT_MS = '25';
  });

  afterEach(() => {
    if (ORIGINAL_TIMEOUT === undefined) delete process.env.HELM_MESSAGE_FLIGHT_TIMEOUT_MS;
    else process.env.HELM_MESSAGE_FLIGHT_TIMEOUT_MS = ORIGINAL_TIMEOUT;
    // A timed-out async body never reaches its own finally — restore here so
    // fake timers cannot leak into the next test and stall its real awaits.
    vi.useRealTimers();
  });

  /** A sink that lets each test decide when the renderer-side flight "lands". */
  function makeFlightSink() {
    const flights: import('../src/session/message-flight.js').SessionMessageFlight[] = [];
    const landings = new Map<string, () => void>();
    const sink = (flight: import('../src/session/message-flight.js').SessionMessageFlight) => {
      flights.push(flight);
      return new Promise<void>(resolve => landings.set(flight.flightId, resolve));
    };
    const land = (flightId: string) => landings.get(flightId)?.();
    return { flights, sink, land };
  }

  it('holds the PTY paste until the flight lands, then delivers', async () => {
    const { service, ptyManager, receiver, sender } = makeDeps();
    const gate = makeFlightSink();
    service.setMessageFlightSink(gate.sink);

    const pending = service.sendTextToSession(receiver.id, 'hello world', {
      senderSessionId: sender.id, senderSessionName: sender.name, expectsResponse: false,
    });
    await Promise.resolve();
    await Promise.resolve();

    expect(gate.flights).toHaveLength(1);
    expect(gate.flights[0]).toMatchObject({
      senderSessionId: sender.id,
      recipientSessionId: receiver.id,
      recipientName: receiver.name,
      isReply: false,
    });
    expect(ptyManager.deliverText).not.toHaveBeenCalled();

    gate.land(gate.flights[0].flightId);
    await pending;
    expect(getSentText(ptyManager)).toContain('hello world');
  });

  it('stops waiting and delivers anyway when nothing acks the flight', async () => {
    vi.useFakeTimers();
    try {
      const { service, ptyManager, receiver, sender } = makeDeps();
      const gate = makeFlightSink();
      service.setMessageFlightSink(gate.sink);

      const pending = service.sendTextToSession(receiver.id, 'unacked', {
        senderSessionId: sender.id, senderSessionName: sender.name,
      });
      // Nothing acks; the flight timeout (25ms here) must release the paste.
      // runAllTimersAsync also flushes the settle-waits the delivery itself
      // schedules after the hold is released.
      await vi.runAllTimersAsync();
      await pending;
      expect(getSentText(ptyManager)).toContain('unacked');
    } finally {
      vi.useRealTimers();
    }
  });

  it('flags a reverse-direction send within the reply window as a reply', async () => {
    const { service, ptyManager, receiver, sender } = makeDeps();
    const gate = makeFlightSink();
    service.setMessageFlightSink(gate.sink);

    const first = service.sendTextToSession(receiver.id, 'initial', {
      senderSessionId: sender.id, senderSessionName: sender.name,
    });
    await Promise.resolve(); await Promise.resolve();
    gate.land(gate.flights[0].flightId);
    await first;

    // The recipient answers back: reverse direction → reply.
    const reply = service.sendTextToSession(sender.id, 'answering', {
      senderSessionId: receiver.id, senderSessionName: receiver.name,
    });
    await Promise.resolve(); await Promise.resolve();
    expect(gate.flights[1].isReply).toBe(true);
    gate.land(gate.flights[1].flightId);
    await reply;
    void ptyManager;
  });
});
