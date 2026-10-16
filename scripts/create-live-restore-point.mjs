/**
 * Snapshot the user-owned Helm session state before an npm test run.
 *
 * Tests are independently isolated in tests/pinia-setup.ts.  This script is a
 * second recovery layer for accidental future path regressions and creates a
 * small, immutable restore point that can be inspected or copied back by an
 * explicit recovery workflow.
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const appData = process.platform === 'win32'
  ? (process.env.APPDATA || join(process.env.USERPROFILE || homedir(), 'AppData', 'Roaming'))
  : process.platform === 'darwin'
    ? join(process.env.HOME || homedir(), 'Library', 'Application Support')
    : (process.env.XDG_CONFIG_HOME || join(process.env.HOME || homedir(), '.config'));
const configDir = join(appData, 'Helm', 'config');
const restoreRoot = join(configDir, 'restore-points');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const destination = join(restoreRoot, stamp);
const files = [
  'sessions.yaml',
  'recycle-bin.yaml',
  'artifacts.yaml',
  'telegram-topics.yaml',
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
