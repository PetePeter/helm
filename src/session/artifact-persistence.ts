import { existsSync, readFileSync } from 'node:fs';
import * as YAML from 'yaml';
import { logger } from '../utils/logger.js';
import type { Artifact, ArtifactVersion } from '../types/artifact.js';
import { ARTIFACTS_FILE } from './persistence-paths.js';
import { atomicWriteFileSync, isAnyString, isNumber, isRecord, isString } from './persistence-utils.js';

function isArtifactVersion(value: unknown): value is ArtifactVersion {
  if (!isRecord(value)) return false;
  return isNumber(value.version)
    && isAnyString(value.content)
    && isNumber(value.createdAt);
}

function isArtifact(value: unknown): value is Artifact {
  if (!isRecord(value)) return false;
  return isString(value.id)
    && isString(value.sessionId)
    && isAnyString(value.title)
    && (value.kind === 'markdown' || value.kind === 'html')
    && Array.isArray(value.versions)
    && value.versions.length > 0        // a versionless artifact would break update()/render
    && value.versions.every(isArtifactVersion)
    && isNumber(value.createdAt)
    && isNumber(value.updatedAt)
    && (value.source === undefined || value.source === 'ai' || value.source === 'manual')
    && (value.intent === undefined || typeof value.intent === 'string');
}

/** A damaged draft costs the user that draft, never the artifact it sits on. */
function withValidDraft(artifact: Artifact): Artifact {
  const draft: unknown = artifact.draft;
  if (draft === undefined) return artifact;
  if (isRecord(draft) && isAnyString(draft.content) && isNumber(draft.updatedAt)) return artifact;
  const { draft: _dropped, ...rest } = artifact;
  return rest;
}

function sanitizeArtifacts(value: unknown): Record<string, Artifact[]> {
  if (!isRecord(value)) return {};
  const result: Record<string, Artifact[]> = {};
  for (const [sessionId, artifacts] of Object.entries(value)) {
    if (!Array.isArray(artifacts)) continue;
    const valid = artifacts.filter(isArtifact).map(withValidDraft).map(artifact => {
      if (artifact.intent !== undefined && artifact.intent !== 'normal' && artifact.intent !== 'manifesto') {
        return { ...artifact, intent: 'normal' as const };
      }
      return artifact;
    });
    if (valid.length > 0) result[sessionId] = valid;
  }
  return result;
}

export function saveArtifacts(all: Record<string, Artifact[]>): void {
  try {
    atomicWriteFileSync(ARTIFACTS_FILE, YAML.stringify({ artifacts: all }));
  } catch (err) {
    logger.error(`Failed to save artifacts: ${err}`);
  }
}

export function loadArtifacts(): Record<string, Artifact[]> {
  try {
    if (!existsSync(ARTIFACTS_FILE)) return {};
    const parsed = YAML.parse(readFileSync(ARTIFACTS_FILE, 'utf8')) as unknown;
    return isRecord(parsed) ? sanitizeArtifacts(parsed.artifacts) : {};
  } catch (err) {
    logger.error(`Failed to load artifacts: ${err}`);
    return {};
  }
}
