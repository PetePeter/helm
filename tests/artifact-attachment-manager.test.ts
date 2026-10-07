import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ArtifactAttachmentManager } from '../src/session/artifact-attachment-manager.js';
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash, randomUUID } from 'node:crypto';

// Use a real temp directory for each test run
let testDir: string;

vi.mock('../src/utils/app-paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils/app-paths.js')>();
  return {
    ...actual,
    getConfigDir: () => testDir,
  };
});

describe('ArtifactAttachmentManager', () => {
  let manager: ArtifactAttachmentManager;

  beforeEach(() => {
    testDir = join(tmpdir(), `helm-test-attachments-${randomUUID()}`);
    mkdirSync(testDir, { recursive: true });
    manager = new ArtifactAttachmentManager(testDir);
  });

  it('adds an attachment and stores the file on disk', () => {
    const content = Buffer.from('hello world');
    const attachment = manager.add('artifact-1', {
      filename: 'test.txt',
      content,
      contentType: 'text/plain',
    });

    expect(attachment.id).toBeDefined();
    expect(attachment.artifactId).toBe('artifact-1');
    expect(attachment.filename).toBe('test.txt');
    expect(attachment.sizeBytes).toBe(11);
    expect(attachment.relativePath).toContain('artifact-1/');

    // File should exist on disk
    const absPath = manager.getPath('artifact-1', attachment.id);
    expect(existsSync(absPath)).toBe(true);
    expect(readFileSync(absPath, 'utf8')).toBe('hello world');
  });

  it('rejects files over 10MB', () => {
    const bigContent = Buffer.alloc(10 * 1024 * 1024 + 1);
    expect(() => {
      manager.add('artifact-1', { filename: 'big.bin', content: bigContent });
    }).toThrow('exceeds 10MB');
  });

  it('stores generated media with its copied size and SHA-256, then deletes it with the artifact', async () => {
    const sourcePath = join(testDir, 'generated.png');
    const bytes = Buffer.from('generated image bytes');
    writeFileSync(sourcePath, bytes);

    const attachment = await manager.addGeneratedMediaFromFile('session-chat', {
      filePath: sourcePath,
      filename: 'result.png',
      contentType: 'image/png',
    });

    expect(attachment).toMatchObject({
      artifactId: 'session-chat',
      filename: 'result.png',
      contentType: 'image/png',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      generatedMedia: true,
    });
    expect(readFileSync(manager.getPath('session-chat', attachment.id))).toEqual(bytes);

    expect(manager.deleteForArtifact('session-chat')).toBe(1);
    expect(manager.get('session-chat', attachment.id)).toBeNull();
  });

  it('deletes all attachments for an artifact', () => {
    manager.add('artifact-1', { filename: 'a.txt', content: Buffer.from('a') });
    manager.add('artifact-1', { filename: 'b.txt', content: Buffer.from('b') });
    const a3 = manager.add('artifact-2', { filename: 'c.txt', content: Buffer.from('c') });

    const deleted = manager.deleteForArtifact('artifact-1');
    expect(deleted).toBe(2);

    // artifact-1 dir should be gone
    expect(existsSync(join(testDir, 'artifact-attachments', 'artifact-1'))).toBe(false);
    // artifact-2 should still exist
    expect(manager.get('artifact-2', a3.id)).toBeTruthy();
  });

  it('prunes orphan attachments not in the live set', () => {
    manager.add('artifact-1', { filename: 'a.txt', content: Buffer.from('a') });
    manager.add('artifact-2', { filename: 'b.txt', content: Buffer.from('b') });
    const a3 = manager.add('artifact-3', { filename: 'c.txt', content: Buffer.from('c') });

    // Only artifact-1 and artifact-3 are live
    manager.pruneOrphans(new Set(['artifact-1', 'artifact-3']));

    expect(manager.get('artifact-1', a3.id)).toBeNull(); // wrong artifact
    expect(manager.get('artifact-3', a3.id)).toBeTruthy();
  });

  it('sanitizes filenames with dangerous characters', () => {
    const attachment = manager.add('artifact-1', {
      filename: '../../../etc/passwd',
      content: Buffer.from('safe'),
    });
    // Should not contain path separators
    expect(attachment.filename).not.toContain('/');
    expect(attachment.filename).not.toContain('..');
  });

  it('returns null for unknown attachment', () => {
    expect(manager.get('artifact-1', 'nonexistent')).toBeNull();
  });

  it('throws when getting path of a missing file', () => {
    const attachment = manager.add('artifact-1', { filename: 'test.txt', content: Buffer.from('test') });
    // Delete the file manually to simulate corruption
    const absPath = manager.getPath('artifact-1', attachment.id);
    rmSync(absPath);

    expect(() => manager.getPath('artifact-1', attachment.id)).toThrow('file missing');
  });

  it('copyForArtifact() duplicates files and index entries under the new artifact, surviving the source', () => {
    const attachment = manager.add('artifact-1', { filename: 'shot.png', content: Buffer.from('png-bytes'), contentType: 'image/png' });

    expect(manager.copyForArtifact('artifact-1', 'artifact-2')).toBe(1);
    manager.deleteForArtifact('artifact-1');

    const [copy] = manager.list('artifact-2');
    expect(copy).toMatchObject({ id: attachment.id, filename: 'shot.png', contentType: 'image/png', sizeBytes: 9 });
    expect(copy.relativePath).toBe(attachment.relativePath.replace('artifact-1', 'artifact-2'));
    expect(readFileSync(manager.getPath('artifact-2', attachment.id), 'utf8')).toBe('png-bytes');
  });

  it('copyForArtifact() returns 0 when the artifact has no attachments', () => {
    expect(manager.copyForArtifact('none', 'artifact-2')).toBe(0);
  });
});

