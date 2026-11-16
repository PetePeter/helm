/**
 * MQTT trigger types — an owner-authored rule maps a topic filter to a prompt
 * delivered to a session. See docs/mqtt-triggers.md.
 */

export interface MqttBrokerConfig {
  /** Off by default: no connection is made until the owner enables it. */
  enabled: boolean;
  /** e.g. mqtt://homeassistant.local:1883 */
  url: string;
  username?: string;
  password?: string;
}

/** Deliver into a named existing session. */
export interface MqttSessionTarget {
  kind: 'session';
  sessionId: string;
}

/**
 * Spawn a session of `cliType` in `dirPath`. With `reuse`, the rule keeps its
 * spawned session (`ownSessionId`) and sends later triggers there while it lives.
 */
export interface MqttSpawnTarget {
  kind: 'spawn';
  cliType: string;
  dirPath: string;
  reuse: boolean;
  ownSessionId?: string;
}

export type MqttRuleTarget = MqttSessionTarget | MqttSpawnTarget;

export interface MqttRule {
  id: string;
  name: string;
  /** MQTT topic filter; `+` and `#` wildcards. */
  topic: string;
  /** Owner-authored template; `{topic}`, `{payload}`, `{payload.a.b}` placeholders. */
  prompt: string;
  target: MqttRuleTarget;
  /** Triggers arriving sooner than this after the last fired one are dropped. */
  minIntervalMs: number;
  enabled: boolean;
  createdAt: number;
  lastFiredAt?: number;
}

export interface CreateMqttRuleParams {
  name: string;
  topic: string;
  prompt: string;
  target: MqttSessionTarget | Omit<MqttSpawnTarget, 'ownSessionId'>;
  minIntervalMs?: number;
  enabled?: boolean;
}

export type UpdateMqttRuleParams = Partial<CreateMqttRuleParams>;

export interface MqttTriggerState {
  broker: MqttBrokerConfig;
  rules: MqttRule[];
}

export type MqttConnectionStatus = 'disabled' | 'connecting' | 'connected' | 'error';

/** What the renderer sees: the broker without its password. */
export interface MqttSnapshot {
  broker: Omit<MqttBrokerConfig, 'password'> & { hasPassword: boolean };
  status: MqttConnectionStatus;
  rules: MqttRule[];
}
