import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMobileShareInputPath } from '../src/mobile/mobile-share-inbox.js';

describe('mobile ComfyUI input path validation', () => {
  let root: string | undefined;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('resolves a regular uploaded file inside the share inbox', () => {
    root = mkdtempSync(join(tmpdir(), 'helm-mobile-inbox-'));
    const inbox = join(root, 'inbox');
    const share = join(inbox, 'share-id');
    mkdirSync(share, { recursive: true });
    const file = join(share, 'source.png');
    writeFileSync(file, Buffer.from([1, 2, 3]));

    expect(resolveMobileShareInputPath(file, inbox)).toBe(file);
  });

  it('rejects paths outside the inbox', () => {
    root = mkdtempSync(join(tmpdir(), 'helm-mobile-inbox-outside-'));
    const inbox = join(root, 'inbox');
    mkdirSync(inbox);
    const file = join(root, 'outside.png');
    writeFileSync(file, Buffer.from([1, 2, 3]));

    expect(() => resolveMobileShareInputPath(file, inbox)).toThrow('must come from the share inbox');
  });
});
