import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import type { MqttRule, MqttTriggerState } from '../types/mqtt-trigger.js';
import { atomicWriteFileSync, isRecord } from './persistence-utils.js';
import { emptyMqttState, normalizeLoadedRule } from './mqtt-trigger-manager.js';

/** Save broker config and rules. `lastFiredAt` is runtime-only rate-limit state. */
export function saveMqttTriggers(state: MqttTriggerState, filePath: string): void {
  try {
    const rules = state.rules.map(({ lastFiredAt: _lastFiredAt, ...rule }) => rule);
    atomicWriteFileSync(filePath, YAML.stringify({ broker: state.broker, rules }));
  } catch (err) {
    logger.error(`[MqttTrigger] Failed to save: ${err}`);
  }
}

export function loadMqttTriggers(filePath: string): MqttTriggerState {
  const state = emptyMqttState();
  try {
    if (!existsSync(filePath)) return state;
    const parsed = YAML.parse(readFileSync(filePath, 'utf8')) as unknown;
    if (!isRecord(parsed)) return state;
    if (isRecord(parsed.broker) && typeof parsed.broker.url === 'string') {
      state.broker = {
        enabled: parsed.broker.enabled === true,
        url: parsed.broker.url,
        ...(typeof parsed.broker.username === 'string' ? { username: parsed.broker.username } : {}),
        ...(typeof parsed.broker.password === 'string' ? { password: parsed.broker.password } : {}),
      };
    }
    if (Array.isArray(parsed.rules)) {
      state.rules = parsed.rules.filter(isRule).map(normalizeLoadedRule).filter((rule): rule is MqttRule => rule !== null);
    }
  } catch (err) {
    logger.error(`[MqttTrigger] Failed to load: ${err}`);
  }
  return state;
}

function isRule(value: unknown): value is MqttRule {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.topic === 'string'
    && typeof value.prompt === 'string'
    && isRecord(value.target)
    && (value.target.kind === 'session' || value.target.kind === 'spawn');
}
