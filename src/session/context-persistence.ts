import { existsSync, readFileSync } from 'node:fs';
import { logger } from '../utils/logger.js';
import type { ContextBinding, ContextNode } from '../types/context.js';
import { atomicWriteFileSync, isRecord, isString } from './persistence-utils.js';

function isContextNode(value: unknown): value is ContextNode {
  return isRecord(value) && isString(value.id) && isString(value.projectId) && isString(value.title);
}

function isContextBinding(value: unknown): value is ContextBinding {
  return isRecord(value) && isString(value.contextId) && isString(value.targetId) && isString(value.targetType);
}

export function savePlanContexts(contexts: ContextNode[], contextsFile?: string): void {
  if (!contextsFile) return;
  try {
    atomicWriteFileSync(contextsFile, JSON.stringify({ version: 1, contexts }, null, 2));
  } catch (err) {
    logger.error(`Failed to save plan contexts: ${err}`);
  }
}

export function loadPlanContexts(contextsFile?: string): ContextNode[] {
  if (!contextsFile) return [];
  try {
    if (!existsSync(contextsFile)) return [];
    const raw = JSON.parse(readFileSync(contextsFile, 'utf8')) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.contexts)) return [];
    return raw.contexts.filter(isContextNode);
  } catch (err) {
    logger.error(`Failed to load plan contexts: ${err}`);
    return [];
  }
}

export function savePlanContextBindings(bindings: ContextBinding[], bindingsFile?: string): void {
  if (!bindingsFile) return;
  try {
    atomicWriteFileSync(bindingsFile, JSON.stringify({ version: 1, bindings }, null, 2));
  } catch (err) {
    logger.error(`Failed to save plan context bindings: ${err}`);
  }
}

export function loadPlanContextBindings(bindingsFile?: string): ContextBinding[] {
  if (!bindingsFile) return [];
  try {
    if (!existsSync(bindingsFile)) return [];
    const raw = JSON.parse(readFileSync(bindingsFile, 'utf8')) as unknown;
    if (!isRecord(raw) || !Array.isArray(raw.bindings)) return [];
    return raw.bindings.filter(isContextBinding);
  } catch (err) {
    logger.error(`Failed to load plan context bindings: ${err}`);
    return [];
  }
}
