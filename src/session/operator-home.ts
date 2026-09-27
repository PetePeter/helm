/**
 * The operator's own home: a folder under the per-user config dir, registered
 * as its own project, so the memories it writes are ITS memories rather than
 * whichever project it happened to spawn in (docs/voice-operator.md).
 */

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectStore } from './project-store.js';

export const OPERATOR_PROJECT_NAME = 'Helm Operator';

/** Create the folder and its project if missing; returns the folder. Idempotent. */
export function ensureOperatorHome(configDir: string, projects: Pick<ProjectStore, 'findByPath' | 'createProject' | 'save'>): string {
  const home = join(configDir, 'operator');
  mkdirSync(home, { recursive: true });
  if (!projects.findByPath(home)) {
    projects.createProject(home, OPERATOR_PROJECT_NAME);
    projects.save();
  }
  return home;
}
