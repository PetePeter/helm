import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getConfigDir } from '../utils/app-paths.js';
import { getGlobalPersistencePaths as getGlobalPersistencePathsFromSharedDefinition } from './global-persistence-paths.mjs';

export interface ProfilePersistencePaths {
  sessionsFile: string;
  plansFile: string;
  plansDir: string;
  planDependenciesFile: string;
  planSequencesFile: string;
  projectsFile: string;
  planContextsFile: string;
  planContextBindingsFile: string;
  scheduledTasksFile: string;
  scheduledTaskHistoryFile: string;
  recycleBinFile: string;
  runtimeGroupsFile: string;
  artifactsFile: string;
  draftsDir: string;
  todosDir: string;
  cliTypesFile: string;
  skillsFile: string;
  skillAnalyticsFile: string;
  configMigrationsFile: string;
  suggestionUsageFile: string;
  apiSessionsDir: string;
  planAttachmentsDir: string;
  artifactAttachmentsDir: string;
  memoriesFile: string;
  memoryAttachmentsDir: string;
  messDir: string;
  timeTrackingDir: string;
}

export interface GlobalPersistencePaths {
  settingsFile: string;
  inputConfigFile: string;
  bindingsFile: string;
  peersFile: string;
  machineIdentityFile: string;
  selfSignedCertFile: string;
  peerPinsFile: string;
  peerSecretsFile: string;
  peerAuditFile: string;
  mobileDevicesFile: string;
  mobileSecretsFile: string;
  mobileChatJournalFile: string;
  /** Mobile subsystem audit data remains machine-shared. */
  mobileAuditFile: string;
  userProfilesFile: string;
  restorePointsDir: string;
  migrationJournalFile: string;
  hooksDir: string;
  operatorDir: string;
}

/** Build every profile-owned persistence path from an explicit profile config directory. */
export function getProfilePersistencePaths(configDir: string): ProfilePersistencePaths {
  return {
    sessionsFile: join(configDir, 'sessions.yaml'),
    plansFile: join(configDir, 'plans.yaml'),
    plansDir: join(configDir, 'plans'),
    planDependenciesFile: join(configDir, 'plan-dependencies.json'),
    planSequencesFile: join(configDir, 'plan-sequences.json'),
    projectsFile: join(configDir, 'projects.json'),
    planContextsFile: join(configDir, 'plan-contexts.json'),
    planContextBindingsFile: join(configDir, 'plan-context-bindings.json'),
    scheduledTasksFile: join(configDir, 'scheduled-tasks.yaml'),
    scheduledTaskHistoryFile: join(configDir, 'scheduled-task-history.yaml'),
    recycleBinFile: join(configDir, 'recycle-bin.yaml'),
    runtimeGroupsFile: join(configDir, 'runtime-groups.yaml'),
    artifactsFile: join(configDir, 'artifacts.yaml'),
    draftsDir: join(configDir, 'drafts'),
    todosDir: join(configDir, 'todos'),
    cliTypesFile: join(configDir, 'cli-types.yaml'),
    skillsFile: join(configDir, 'skills.yaml'),
    skillAnalyticsFile: join(configDir, 'skill-analytics.json'),
    configMigrationsFile: join(configDir, 'config-migrations.yaml'),
    suggestionUsageFile: join(configDir, 'suggestion-usage.json'),
    apiSessionsDir: join(configDir, 'api-sessions'),
    planAttachmentsDir: join(configDir, 'plan-attachments'),
    artifactAttachmentsDir: join(configDir, 'artifact-attachments'),
    memoriesFile: join(configDir, 'memories.json'),
    memoryAttachmentsDir: join(configDir, 'memory-attachments'),
    messDir: join(configDir, 'mess'),
    timeTrackingDir: join(configDir, 'time-tracking'),
  };
}

/** Build every machine-shared config path from the canonical shared definition. */
export function getGlobalPersistencePaths(configDir: string): GlobalPersistencePaths {
  return getGlobalPersistencePathsFromSharedDefinition(configDir) as unknown as GlobalPersistencePaths;
}

const persistenceDirname = dirname(fileURLToPath(import.meta.url));
const globalPaths = getGlobalPersistencePaths(getConfigDir(persistenceDirname));

export const PEERS_FILE = globalPaths.peersFile;
export const MACHINE_IDENTITY_FILE = globalPaths.machineIdentityFile;
export const SELF_SIGNED_CERT_FILE = globalPaths.selfSignedCertFile;
export const PEER_PINS_FILE = globalPaths.peerPinsFile;
export const PEER_SECRETS_FILE = globalPaths.peerSecretsFile;
export const PEER_AUDIT_FILE = globalPaths.peerAuditFile;
/** Paired phones. No secret material — only pskRef references. */
export const MOBILE_DEVICES_FILE = globalPaths.mobileDevicesFile;
/** Mobile pairing PSKs, base64, mode 0600. The ONLY place they are stored. */
export const MOBILE_SECRETS_FILE = globalPaths.mobileSecretsFile;
/** Rolling record of chat messages fanned out to phones; catch-up replays from it. */
export const MOBILE_CHAT_JOURNAL_FILE = globalPaths.mobileChatJournalFile;

function assertSafeProjectId(projectId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(projectId)) {
    throw new Error('Mess project id must be a safe immutable identifier');
  }
}

/** The immutable project UUID, rather than its name or path, owns these files. */
export function getMessLogPath(projectId: string, directory: string): string {
  assertSafeProjectId(projectId);
  return join(directory, `${projectId}.jsonl`);
}

export function getMessCursorPath(projectId: string, directory: string): string {
  assertSafeProjectId(projectId);
  return join(directory, `${projectId}.cursors.json`);
}
