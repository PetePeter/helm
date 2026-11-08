/**
 * Snapshot the user-owned Helm session state before an npm test run.
 *
 * Tests are independently isolated in tests/pinia-setup.ts.  This script is a
 * second recovery layer for accidental future path regressions and creates a
 * small, immutable restore point that can be inspected or copied back by an
 * explicit recovery workflow. Its source follows profile migration, while the
 * archive stays global so migration cannot split existing restore history.
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { getGlobalPersistencePaths } from '../src/session/global-persistence-paths.mjs';

const appData = process.platform === 'win32'
  ? (process.env.APPDATA || join(process.env.USERPROFILE || homedir(), 'AppData', 'Roaming'))
  : process.platform === 'darwin'
    ? join(process.env.HOME || homedir(), 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config'));
const globalConfigDir = join(appData, 'Helm', 'config');
const profileConfigDir = join(appData, 'Helm', 'profiles', '1', 'config');
const configDir = getSnapshotConfigDir(globalConfigDir, profileConfigDir);
const globalPaths = getGlobalPersistencePaths(globalConfigDir);
const restoreRoot = globalPaths.restorePointsDir;
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = join(restoreRoot, stamp);
const files = [
  'sessions.yaml',
  'recycle-bin.yaml',
  'artifacts.yaml',
  'scheduled-tasks.yaml',
  'scheduled-task-history.yaml',
  'runtime-groups.yaml',
];

mkdirSync(destination, { recursive: true });
const copied = [];
for (const name of files) {
  const source = join(configDir, name);
  if (!existsSync(source)) continue;
  cpSync(source, join(destination, name));
  copied.push(name);
}
writeFileSync(join(destination, 'manifest.json'), JSON.stringify({
  createdAt: new Date().toISOString(),
  source: configDir,
  files: copied,
}, null, 2));

// Keep the thirty newest points.  They are intentionally never restored or
// overwritten by this script.
const snapshots = readdirSync(restoreRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => entry.name)
  .sort()
  .reverse();
for (const old of snapshots.slice(30)) rmSync(join(restoreRoot, old), { recursive: true, force: true });

console.log(`[restore-point] ${destination} (${copied.length} file(s))`);

function getSnapshotConfigDir(globalConfigDir, profileConfigDir) {
  const journalPath = getGlobalPersistencePaths(globalConfigDir).migrationJournalFile;
  if (!existsSync(journalPath)) return globalConfigDir;

  const journal = YAML.parse(readFileSync(journalPath, 'utf8'));
  if (!journal || journal.version !== 1
    || (journal.status !== 'in-progress' && journal.status !== 'complete')
    || typeof journal.startedAt !== 'number'
    || typeof journal.updatedAt !== 'number') {
    throw new Error(`Invalid profile config migration journal: ${journalPath}`);
  }
  if (journal.status === 'in-progress') {
    throw new Error('Cannot create a restore point while profile config migration is in progress');
  }
  return profileConfigDir;
}
