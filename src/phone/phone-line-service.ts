/**
 * PhoneLineService — the one object main wires in. Owns the telefony-app
 * process, the PhAP client and the PhoneBridge, and re-applies settings:
 * a change to anything written into telefony.toml restarts telefony, but
 * never under a live call (the restart waits for the line to go idle).
 *
 * It is the stable ChatBridge registered with the broker; the client and
 * bridge behind it are rebuilt when the port or token changes.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import type { ChatClient } from '../session/api/api-agent-loop.js';
import type { ChatBridge, ChatOutboundMessage, ChatSendResult } from '../session/chat/chat-bridge.js';
import { PhapClient } from './phap-client.js';
import { PhoneBridge, PHONE_PROVIDER, type CallAgentRequest, type PhoneBridgeStatus, type SmsMemory } from './phone-bridge.js';
import type { PhoneLineConfig } from './phone-config.js';
import { TelefonyProcess, renderTelefonyToml, type TelefonyStatus } from './telefony-process.js';

export interface PhoneLineServiceDeps {
  getConfig: () => PhoneLineConfig;
  saveConfig: (cfg: PhoneLineConfig) => void;
  /** Where Helm writes telefony.toml. */
  telefonyConfigPath: string;
  defaultTranscriptDir: string;
  getAppVersion: () => string;
  getOperatorId: () => string | null;
  sessionName: (sessionId: string) => string | undefined;
  deliver: (sessionId: string, text: string) => Promise<void>;
  log: (msg: string) => void;
  /** The model client of an API tool, by CLI type id; null when it is gone or not an API tool. */
  apiModel?: (cliTypeId: string) => ChatClient | null;
  /** Test seam: the telefony process (real by default). */
  process?: TelefonyProcess;
}

export interface PhoneLineStatus {
  enabled: boolean;
  process: TelefonyStatus;
  pendingRestart: boolean;
  line: PhoneBridgeStatus | null;
  configPath: string;
}

export class PhoneLineService extends EventEmitter implements ChatBridge {
  readonly provider = PHONE_PROVIDER;
  private readonly proc: TelefonyProcess;
  private client: PhapClient | null = null;
  private bridge: PhoneBridge | null = null;
  private appliedToml = '';
  private appliedLink = '';
  private pendingRestart = false;
  private sweepTimer: NodeJS.Timeout | null = null;
  private readonly smsMemory: SmsMemory = { seen: new Set(), received: new Set(), primed: false };
  private applying: Promise<void> = Promise.resolve();

  constructor(private readonly deps: PhoneLineServiceDeps) {
    super();
    this.proc = deps.process ?? new TelefonyProcess({ configPath: deps.telefonyConfigPath, log: deps.log });
    this.proc.on('status', () => this.emitStatus());
  }

  /** Bring the line in line with settings. Safe to call on every save; calls run one at a time. */
  apply(): Promise<void> {
    this.applying = this.applying.then(() => this.applyNow(), () => this.applyNow());
    return this.applying;
  }

  private async applyNow(): Promise<void> {
    let cfg = this.deps.getConfig();
    if (!cfg.enabled) { await this.stopNow(); return; }
    if (!cfg.token) {
      cfg = { ...cfg, token: randomBytes(24).toString('base64url') };
      this.deps.saveConfig(cfg);
    }
    const link = `${cfg.port}|${cfg.token}|${cfg.heartbeatS}`;
    const toml = renderTelefonyToml(cfg);
    const procState = this.proc.getStatus().state;
    const needsRestart = toml !== this.appliedToml || procState === 'stopped' || procState === 'failed';
    if ((link !== this.appliedLink || needsRestart) && this.bridge?.getStatus().call) {
      // Never under a live call: both the link and telefony wait for it to end.
      this.pendingRestart = true;
      this.emitStatus();
      return;
    }
    if (link !== this.appliedLink) this.rebuildLink(cfg, link);
    if (needsRestart) await this.restartProcess(cfg, toml);
    this.emitStatus();
  }

  stop(): Promise<void> {
    this.applying = this.applying.then(() => this.stopNow(), () => this.stopNow());
    return this.applying;
  }

  private async stopNow(): Promise<void> {
    this.pendingRestart = false;
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.sweepTimer = null;
    await this.bridge?.hangupAll();
    this.bridge?.stop();
    this.client?.stop();
    this.bridge = null;
    this.client = null;
    this.appliedLink = '';
    this.appliedToml = '';
    await this.proc.stop();
    this.emitStatus();
  }

  getStatus(): PhoneLineStatus {
    return {
      enabled: this.deps.getConfig().enabled,
      process: this.proc.getStatus(),
      pendingRestart: this.pendingRestart,
      line: this.bridge?.getStatus() ?? null,
      configPath: this.deps.telefonyConfigPath,
    };
  }

  /** Force a telefony restart (Settings button); refused under a live call. */
  async restart(): Promise<void> {
    if (this.bridge?.getStatus().call) throw new Error('A call is live — hang up first.');
    const cfg = this.deps.getConfig();
    if (cfg.enabled) await this.restartProcess(cfg, renderTelefonyToml(cfg));
  }

  // ---- delegated surface ---------------------------------------------------

  isAvailable(): boolean { return this.bridge?.isAvailable() ?? false; }

  sendToSession(message: ChatOutboundMessage): Promise<ChatSendResult> {
    return this.bridge?.sendToSession(message) ?? Promise.resolve({ sent: false, reason: 'phone line off' });
  }

  ringOwner(sessionId: string, reason: string): boolean {
    return this.deps.getConfig().fallback.ring && (this.bridge?.ringOwner(sessionId, reason) ?? false);
  }

  /** notify_user fallback (off by default — notifications are frequent). */
  notifyOwner(title: string, content: string): void {
    if (!this.deps.getConfig().fallback.notify || !this.bridge) return;
    void this.bridge.textOwner(`${title}: ${content}`).catch((err) => this.deps.log(`phone notify failed: ${(err as Error).message}`));
  }

  /** Settings test button. */
  testSms(): Promise<ChatSendResult> {
    return this.requireBridge().textOwner(`${this.deps.getConfig().persona.name}: phone line test.`);
  }

  /** Settings test button: ring the owner on behalf of the operator. */
  testRing(): boolean {
    const operator = this.deps.getOperatorId();
    return !!operator && !!this.bridge?.ringOwner(operator, 'This is a phone line test.');
  }
  transfer(from: string, to: string, line: string): boolean { return this.bridge?.transfer(from, to, line) ?? false; }
  hangup(sessionId: string) { return this.requireBridge().hangup(sessionId); }
  conferenceAdd(sessionId: string, label: string) { return this.requireBridge().conferenceAdd(sessionId, label); }
  inbox() { return this.requireBridge().inbox(); }
  startCallAgent(sessionId: string, req: CallAgentRequest) { return this.requireBridge().startCallAgent(sessionId, req); }

  // ---- internals -------------------------------------------------------------

  /** The model of an API tool picked in Settings > Phone line; null when unset or deleted. */
  private apiModel(id: string, what: string): ChatClient | null {
    if (!id) return null;
    const model = this.deps.apiModel?.(id) ?? null;
    if (!model) this.deps.log(`${what} model ${id} is not an API tool any more`);
    return model;
  }

  private requireBridge(): PhoneBridge {
    if (!this.bridge?.isAvailable()) throw new Error('The phone line is not connected (Settings > Phone line).');
    return this.bridge;
  }

  private rebuildLink(cfg: PhoneLineConfig, link: string): void {
    this.bridge?.stop();
    this.client?.stop();
    const client = new PhapClient({
      uri: `ws://127.0.0.1:${cfg.port}/phap`, token: cfg.token, clientVersion: this.deps.getAppVersion(),
      heartbeatS: cfg.heartbeatS, log: this.deps.log,
    });
    const bridge = new PhoneBridge({
      client,
      getConfig: this.deps.getConfig,
      getOperatorId: this.deps.getOperatorId,
      sessionName: this.deps.sessionName,
      deliver: this.deps.deliver,
      defaultTranscriptDir: this.deps.defaultTranscriptDir,
      log: this.deps.log,
      smsMemory: this.smsMemory,
      callAgentModel: () => this.apiModel(this.deps.getConfig().callAgentModel, 'call agent'),
      callReplyModel: () => this.apiModel(this.deps.getConfig().callReplyModel, 'call reply'),
    });
    client.on('dead', () => { void this.proc.restart('PhAP heartbeat lost'); });
    bridge.on('status', (s: PhoneBridgeStatus) => {
      if (this.pendingRestart && !s.call) void this.apply();
      this.emitStatus();
    });
    bridge.start();
    client.start();
    this.client = client;
    this.bridge = bridge;
    this.appliedLink = link;
    if (!this.sweepTimer) {
      const sweep = () => { void this.bridge?.sweepTranscripts().catch((err) => this.deps.log(`transcript sweep failed: ${(err as Error).message}`)); };
      sweep();
      this.sweepTimer = setInterval(sweep, 24 * 3_600_000);
      this.sweepTimer.unref?.();
    }
  }

  private async restartProcess(cfg: PhoneLineConfig, toml: string): Promise<void> {
    this.pendingRestart = false;
    if (!cfg.executable || !cfg.transport) {
      this.deps.log('phone line: set the telefony-app executable and Bluetooth transport first');
      return;
    }
    await this.proc.start(cfg);
    this.appliedToml = toml;
  }

  private emitStatus(): void { this.emit('status', this.getStatus()); }
}
