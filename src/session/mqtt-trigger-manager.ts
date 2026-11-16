/**
 * MqttTriggerManager — owns the profile's MQTT rules and broker connection.
 *
 * A message on a topic that matches an enabled rule becomes that rule's prompt,
 * delivered to its target session. Unmatched messages are ignored. Delivery and
 * spawning are injected so the manager stays free of PTY/session plumbing.
 */
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import mqtt, { type MqttClient } from 'mqtt';
import { logger } from '../utils/logger.js';
import { assertTopicFilter, renderTriggerPrompt, topicMatches } from './mqtt-trigger.js';
import type {
  CreateMqttRuleParams, MqttBrokerConfig, MqttConnectionStatus, MqttRule, MqttRuleTarget,
  MqttTriggerState, UpdateMqttRuleParams,
} from '../types/mqtt-trigger.js';

export const DEFAULT_MQTT_URL = 'mqtt://homeassistant.local:1883';
export const DEFAULT_MIN_INTERVAL_MS = 5_000;

export interface MqttSpawnRequest {
  cliType: string;
  dirPath: string;
  name: string;
  prompt: string;
}

export interface MqttTriggerDeps {
  initial?: MqttTriggerState;
  persist: (state: MqttTriggerState) => void;
  deliver: (sessionId: string, text: string) => Promise<void>;
  /** Spawns a session delivering `prompt` as its first message; returns its id. */
  spawn: (request: MqttSpawnRequest) => string;
  sessionExists: (sessionId: string) => boolean;
  connect?: (config: MqttBrokerConfig) => MqttClient;
  now?: () => number;
}

export function emptyMqttState(): MqttTriggerState {
  return { broker: { enabled: false, url: DEFAULT_MQTT_URL }, rules: [] };
}

function defaultConnect(config: MqttBrokerConfig): MqttClient {
  return mqtt.connect(config.url, {
    ...(config.username ? { username: config.username } : {}),
    ...(config.password ? { password: config.password } : {}),
    reconnectPeriod: 5_000,
    connectTimeout: 10_000,
  });
}

export class MqttTriggerManager extends EventEmitter {
  private state: MqttTriggerState;
  private client: MqttClient | null = null;
  private subscribed = new Set<string>();
  private status: MqttConnectionStatus = 'disabled';
  private readonly now: () => number;

  constructor(private readonly deps: MqttTriggerDeps) {
    super();
    this.state = deps.initial ?? emptyMqttState();
    this.now = deps.now ?? Date.now;
  }

  // --- Broker -------------------------------------------------------------

  getBroker(): MqttBrokerConfig { return { ...this.state.broker }; }
  getStatus(): MqttConnectionStatus { return this.status; }

  setBroker(update: Partial<MqttBrokerConfig>): MqttBrokerConfig {
    const next: MqttBrokerConfig = { ...this.state.broker };
    if (update.enabled !== undefined) next.enabled = update.enabled === true;
    for (const key of ['url', 'username', 'password'] as const) {
      const value = update[key];
      if (value === undefined) continue;
      if (typeof value !== 'string') throw new Error(`${key} must be a string`);
      next[key] = key === 'password' ? value : value.trim();
    }
    if (!next.url) throw new Error('Broker url is required');
    this.state.broker = next;
    this.save();
    this.start();
    return this.getBroker();
  }

  /** (Re)connect per the broker config; a disabled broker just disconnects. */
  start(): void {
    this.stop();
    if (!this.state.broker.enabled) return;
    this.setStatus('connecting');
    const client = (this.deps.connect ?? defaultConnect)(this.state.broker);
    this.client = client;
    client.on('connect', () => {
      this.subscribed.clear();
      this.setStatus('connected');
      this.syncSubscriptions();
    });
    // mqtt.js reconnects by itself; show that instead of a stale "connected".
    client.on('offline', () => this.setStatus('connecting'));
    client.on('close', () => {
      this.subscribed.clear();
      // 'close' follows 'error' (refused, bad auth): keep the error visible until a connect succeeds.
      if (this.status !== 'error') this.setStatus('connecting');
    });
    client.on('error', (err) => {
      logger.warn(`[MqttTrigger] Broker error: ${err.message}`);
      this.setStatus('error');
    });
    client.on('message', (topic, payload) => { void this.handleMessage(topic, payload.toString('utf8')); });
  }

  stop(): void {
    if (this.client) {
      this.client.removeAllListeners();
      // A closing socket can still emit 'error'; with no listener Node would throw.
      this.client.on('error', () => {});
      this.client.end(true);
      this.client = null;
    }
    this.subscribed.clear();
    this.setStatus('disabled');
  }

  // --- Rules --------------------------------------------------------------

  listRules(): MqttRule[] { return this.state.rules.map(rule => ({ ...rule, target: { ...rule.target } })); }

  createRule(params: CreateMqttRuleParams): MqttRule {
    const rule: MqttRule = {
      id: randomUUID(),
      createdAt: this.now(),
      ...validated(params as Required<CreateMqttRuleParams>),
    };
    this.state.rules.push(rule);
    this.rulesChanged();
    return { ...rule };
  }

  updateRule(id: string, update: UpdateMqttRuleParams): MqttRule {
    const rule = this.requireRule(id);
    const merged = validated({
      name: update.name ?? rule.name,
      topic: update.topic ?? rule.topic,
      prompt: update.prompt ?? rule.prompt,
      target: update.target ?? rule.target,
      minIntervalMs: update.minIntervalMs ?? rule.minIntervalMs,
      enabled: update.enabled ?? rule.enabled,
    });
    // A replaced target arrives without ownSessionId, so it forgets the old spawn.
    Object.assign(rule, merged);
    this.rulesChanged();
    return { ...rule };
  }

  deleteRule(id: string): boolean {
    const before = this.state.rules.length;
    this.state.rules = this.state.rules.filter(rule => rule.id !== id);
    if (this.state.rules.length === before) return false;
    this.rulesChanged();
    return true;
  }

  // --- Triggering ---------------------------------------------------------

  /** Fire every enabled rule matching `topic`. Exposed for the in-process path and tests. */
  async handleMessage(topic: string, payload: string): Promise<void> {
    const matching = this.state.rules.filter(rule => rule.enabled && topicMatches(rule.topic, topic));
    for (const rule of matching) {
      const now = this.now();
      if (rule.lastFiredAt !== undefined && now - rule.lastFiredAt < rule.minIntervalMs) {
        logger.info(`[MqttTrigger] Rule "${rule.name}" dropped ${topic}: rate limited`);
        continue;
      }
      rule.lastFiredAt = now;
      const prompt = renderTriggerPrompt(rule.prompt, topic, payload);
      try {
        const sessionId = await this.fire(rule, prompt);
        logger.info(`[MqttTrigger] Rule "${rule.name}" fired on ${topic} -> session ${sessionId}`);
        this.emit('triggered', { ruleId: rule.id, topic, sessionId });
      } catch (err) {
        logger.error(`[MqttTrigger] Rule "${rule.name}" failed on ${topic}: ${err instanceof Error ? err.message : err}`);
      }
      this.save();
    }
  }

  private async fire(rule: MqttRule, prompt: string): Promise<string> {
    const target = rule.target;
    if (target.kind === 'session') {
      await this.deps.deliver(target.sessionId, prompt);
      return target.sessionId;
    }
    if (target.reuse && target.ownSessionId && this.deps.sessionExists(target.ownSessionId)) {
      await this.deps.deliver(target.ownSessionId, prompt);
      return target.ownSessionId;
    }
    const sessionId = this.deps.spawn({ cliType: target.cliType, dirPath: target.dirPath, name: `[mqtt] ${rule.name}`, prompt });
    if (target.reuse) target.ownSessionId = sessionId;
    return sessionId;
  }

  // --- Internals ----------------------------------------------------------

  private requireRule(id: string): MqttRule {
    const rule = this.state.rules.find(r => r.id === id);
    if (!rule) throw new Error(`MQTT rule ${id} not found`);
    return rule;
  }

  private rulesChanged(): void {
    this.save();
    this.syncSubscriptions();
  }

  private syncSubscriptions(): void {
    const client = this.client;
    if (!client || this.status !== 'connected') return;
    const wanted = new Set(this.state.rules.filter(rule => rule.enabled).map(rule => rule.topic));
    const drop = [...this.subscribed].filter(topic => !wanted.has(topic));
    const add = [...wanted].filter(topic => !this.subscribed.has(topic));
    if (drop.length) client.unsubscribe(drop);
    if (add.length) {
      client.subscribe(add, (err) => {
        if (err) {
          logger.warn(`[MqttTrigger] Subscribe failed: ${err.message}`);
          add.forEach(topic => this.subscribed.delete(topic)); // retried on the next sync
        }
        else this.emit('subscribed', add);
      });
    }
    this.subscribed = wanted;
  }

  private setStatus(status: MqttConnectionStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.emit('status', status);
  }

  private save(): void {
    this.deps.persist(this.state);
    this.emit('changed');
  }
}

/** Re-validate a persisted rule; anything that no longer validates is dropped. */
export function normalizeLoadedRule(raw: MqttRule): MqttRule | null {
  try {
    return { id: raw.id, createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0, ...validated(raw as unknown as Required<CreateMqttRuleParams>) };
  } catch (err) {
    logger.warn(`[MqttTrigger] Dropping invalid stored rule ${raw.id}: ${err instanceof Error ? err.message : err}`);
    return null;
  }
}

function validated(params: Required<CreateMqttRuleParams>): Omit<MqttRule, 'id' | 'createdAt'> {
  const name = params.name?.trim();
  if (!name) throw new Error('name is required');
  assertTopicFilter(params.topic ?? '');
  if (!params.prompt?.trim()) throw new Error('prompt is required');
  const minIntervalMs = params.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS;
  if (typeof minIntervalMs !== 'number' || !Number.isFinite(minIntervalMs) || minIntervalMs < 0) throw new Error('minIntervalMs must be >= 0');
  return {
    name,
    topic: params.topic.trim(),
    prompt: params.prompt,
    target: validatedTarget(params.target),
    minIntervalMs,
    enabled: params.enabled !== false,
  };
}

function validatedTarget(target: CreateMqttRuleParams['target'] | undefined): MqttRuleTarget {
  if (target?.kind === 'session') {
    if (!target.sessionId?.trim()) throw new Error('target.sessionId is required');
    return { kind: 'session', sessionId: target.sessionId.trim() };
  }
  if (target?.kind === 'spawn') {
    if (!target.cliType?.trim()) throw new Error('target.cliType is required');
    if (!target.dirPath?.trim()) throw new Error('target.dirPath is required');
    return {
      kind: 'spawn', cliType: target.cliType.trim(), dirPath: target.dirPath.trim(), reuse: target.reuse === true,
      ...('ownSessionId' in target && typeof target.ownSessionId === 'string' ? { ownSessionId: target.ownSessionId } : {}),
    };
  }
  throw new Error('target.kind must be "session" or "spawn"');
}
