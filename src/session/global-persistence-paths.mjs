import { join } from 'node:path';

export const GLOBAL_PERSISTENCE_PATH_NAMES = Object.freeze({
  settingsFile: 'settings.yaml',
  inputConfigFile: 'input-config.yaml',
  bindingsFile: 'bindings.yaml',
  peersFile: 'peers.yaml',
  machineIdentityFile: 'machine-identity.yaml',
  selfSignedCertFile: 'self-signed-cert.yaml',
  peerPinsFile: 'peer-pins.yaml',
  peerSecretsFile: 'peer-secrets.yaml',
  peerAuditFile: 'peer-audit.yaml',
  mobileDevicesFile: 'mobile-devices.yaml',
  mobileSecretsFile: 'mobile-secrets.yaml',
  mobileChatJournalFile: 'mobile-chat-journal.json',
  mobileAuditFile: 'mobile-audit.yaml',
  userProfilesFile: 'user-profiles.yaml',
  restorePointsDir: 'restore-points',
  migrationJournalFile: 'user-profile-migration.yaml',
  hooksDir: 'hooks',
  operatorDir: 'operator',
});

export function getGlobalPersistencePaths(configDir) {
  return Object.fromEntries(
    Object.entries(GLOBAL_PERSISTENCE_PATH_NAMES).map(([key, name]) => [key, join(configDir, name)]),
  );
}
