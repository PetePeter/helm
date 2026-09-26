/**
 * Global test setup — initialises Pinia before each test so that store
 * access from reactive state shims (and future Vue component tests) works.
 */

import { beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Production persistence resolves beneath the platform app-data base
// (APPDATA on Windows, $HOME/Library/Application Support on macOS,
// XDG_CONFIG_HOME on Linux). Point every one of them at a disposable directory
// before any test module is imported, so tests never touch a developer's live
// Helm state. Each Vitest worker gets its own process and isolated directory.
// realpath: macOS tmpdir sits behind the /var symlink, which symlink-refusing storage rejects.
const testAppData = realpathSync(mkdtempSync(join(tmpdir(), 'helm-vitest-appdata-')));
process.env.APPDATA = testAppData;
process.env.XDG_CONFIG_HOME = testAppData;
process.env.HOME = testAppData;

// Cleanup runs on worker exit, not in afterAll: Vitest 4 rejects a top-level
// afterAll in a setup file ("failed to find the current suite") because there
// is no suite to attach it to, which failed every test file in the repo.
process.on('exit', () => { rmSync(testAppData, { recursive: true, force: true }); });

beforeEach(() => {
  setActivePinia(createPinia());
});
