/**
 * The operator's own home: a folder under the config dir registered as its own
 * project, so its memories are its own. Real ProjectStore, real temp dir.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ProjectStore } from '../src/session/project-store.js';
import { ensureOperatorHome, OPERATOR_PROJECT_NAME } from '../src/session/operator-home.js';

let dir: string;
afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); });

describe('ensureOperatorHome', () => {
  it('creates the folder and registers it as the operator project, once', () => {
    dir = mkdtempSync(join(tmpdir(), 'helm-op-'));
    const store = new ProjectStore();

    const home = ensureOperatorHome(dir, store);
    const again = ensureOperatorHome(dir, store);

    expect(home).toBe(join(dir, 'operator'));
    expect(again).toBe(home);
    expect(existsSync(home)).toBe(true);
    const matching = store.list().filter((p) => p.name === OPERATOR_PROJECT_NAME);
    expect(matching).toHaveLength(1);
    expect(store.findByPath(home)?.id).toBe(matching[0].id);
  });
});
