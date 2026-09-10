/**
 * Global test setup — initialises Pinia before each test so that store
 * access from reactive state shims (and future Vue component tests) works.
 */

import { beforeEach } from 'vitest';
import { setActivePinia, createPinia } from 'pinia';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Production persistence resolves beneath APPDATA/Helm.  Set APPDATA before
// every test module is imported so persistence-focused tests use a disposable
// directory instead of a developer's live Helm state.  Each Vitest worker gets
// its own process and therefore its own isolated directory.
const testAppData = mkdtempSync(join(tmpdir(), 'helm-vitest-appdata-'));
process.env.APPDATA = testAppData;

// Cleanup runs on worker exit, not in afterAll: Vitest 4 rejects a top-level
// afterAll in a setup file ("failed to find the current suite") because there
// is no suite to attach it to, which failed every test file in the repo.
process.on('exit', () => { rmSync(testAppData, { recursive: true, force: true }); });

beforeEach(() => {
  setActivePinia(createPinia());
});
