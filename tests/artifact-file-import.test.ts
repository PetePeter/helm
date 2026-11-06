import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { ArtifactManager } from '../src/session/artifact-manager.js';
import { ArtifactAttachmentManager } from '../src/session/artifact-attachment-manager.js';
import { createArtifactFromBytes, updateArtifactFromBytes } from '../src/session/artifact-file-import.js';
import { HelmControlService } from '../src/mcp/helm-control-service.js';

const sessions = new Set<string>();

afterEach(() => {
  for (const dir of sessions) rmSync(dir, { recursive: true, force: true });
  sessions.clear();
});

function makeStores() {
  const dir = join(tmpdir(), `helm-artifact-file-${randomUUID()}`);
  mkdirSync(dir, { recursive: true });
  sessions.add(dir);
  return {
    dir,
    artifacts: new ArtifactManager(),
    attachments: new ArtifactAttachmentManager(dir),
  };
}

describe('artifact file import', () => {
  it('supports MCP path create, update, inline retrieval, and temp-file retrieval', () => {
    const { dir, artifacts, attachments } = makeStores();
    const source = join(dir, 'report.txt');
    writeFileSync(source, 'first body', 'utf8');

    const service = Object.create(HelmControlService.prototype) as any;
    service.artifactManager = artifacts;
    service.artifactAttachmentManager = attachments;

    const created = service.createArtifactFromFile('sess-1', source);
    expect(readFileSync(source, 'utf8')).toBe('first body');
    writeFileSync(source, 'second body', 'utf8');
    const updated = service.updateArtifactFromFile('sess-1', created.artifact.id, source);
    expect(updated.artifact.versions).toHaveLength(2);
    expect(service.getArtifact('sess-1', created.artifact.id).versions).toHaveLength(2);

    const temp = service.getArtifact('sess-1', created.artifact.id, 2, { asFile: true });
    expect(readFileSync(temp.tempPath, 'utf8')).toBe('```\nsecond body\n```');
    expect(existsSync(temp.tempPath)).toBe(true);
    unlinkSync(temp.tempPath);
    expect(existsSync(source)).toBe(true);
  });

  it('returns original binary attachments through artifact_get without exposing storage paths', () => {
    const { dir, artifacts, attachments } = makeStores();
    const source = join(dir, 'report.pdf');
    writeFileSync(source, '%PDF-1.7', 'utf8');

    const service = Object.create(HelmControlService.prototype) as any;
    service.artifactManager = artifacts;
    service.artifactAttachmentManager = attachments;
    const created = service.createArtifactFromFile('sess-1', source, undefined, 'application/pdf');
    const temp = service.getArtifact('sess-1', created.artifact.id, undefined, {
      attachmentId: created.attachment.id,
    });

    expect(temp.tempPath).not.toBe(attachments.getPath(created.artifact.id, created.attachment.id));
    expect(readFileSync(temp.tempPath, 'utf8')).toBe('%PDF-1.7');
    unlinkSync(temp.tempPath);
  });

  it('inlines small text files as a single markdown artifact version', () => {
    const { artifacts, attachments } = makeStores();
    const result = createArtifactFromBytes(artifacts, attachments, 'sess-1', {
      filename: 'report.json',
      content: Buffer.from('{"ok":true}'),
      contentType: 'application/json',
    });

    expect(result.attachment).toBeUndefined();
    expect(result.artifact.kind).toBe('markdown');
    expect(result.artifact.versions[0].content).toContain('```json');
    expect(result.artifact.versions[0].content).toContain('{"ok":true}');
  });

  it('imports an html file as an html artifact with its raw source', () => {
    const { artifacts, attachments } = makeStores();
    const html = '<!doctype html><h1>Report</h1>';
    const result = createArtifactFromBytes(artifacts, attachments, 'sess-1', {
      filename: 'report.html', content: Buffer.from(html), contentType: 'text/html',
    });

    expect(result.artifact.kind).toBe('html');
    expect(result.artifact.versions[0].content).toBe(html);
  });

  it('stores binary files as attachments and returns the attachment id', () => {
    const { artifacts, attachments } = makeStores();
    const result = createArtifactFromBytes(artifacts, attachments, 'sess-1', {
      filename: 'report.pdf',
      content: Buffer.from('%PDF-1.7'),
      contentType: 'application/pdf',
    });

    expect(result.attachment).toBeDefined();
    expect(result.artifact.versions[0].content).toContain('Open in system viewer');
    expect(readFileSync(attachments.getPath(result.artifact.id, result.attachment!.id), 'utf8')).toBe('%PDF-1.7');
  });

  it('adds a new version and retains prior binary attachments on file update', () => {
    const { artifacts, attachments } = makeStores();
    const first = createArtifactFromBytes(artifacts, attachments, 'sess-1', {
      filename: 'one.bin', content: Buffer.from('one'), contentType: 'application/octet-stream',
    });
    const second = updateArtifactFromBytes(artifacts, attachments, first.artifact, {
      filename: 'two.bin', content: Buffer.from('two'), contentType: 'application/octet-stream',
    });

    expect(second.artifact.versions).toHaveLength(2);
    expect(second.attachment).toBeDefined();
    expect(attachments.get(first.artifact.id, first.attachment!.id)).not.toBeNull();
    expect(attachments.get(first.artifact.id, second.attachment!.id)).not.toBeNull();
  });

  it('rolls back an attachment if the artifact update fails', () => {
    const { dir, artifacts, attachments } = makeStores();
    const first = createArtifactFromBytes(artifacts, attachments, 'sess-1', {
      filename: 'one.bin', content: Buffer.from('one'), contentType: 'application/octet-stream',
    });
    vi.spyOn(artifacts, 'update').mockReturnValue(null);

    expect(() => updateArtifactFromBytes(artifacts, attachments, first.artifact, {
      filename: 'two.bin', content: Buffer.from('two'), contentType: 'application/octet-stream',
    })).toThrow(`Artifact not found: ${first.artifact.id}`);
    const index = JSON.parse(readFileSync(join(dir, 'artifact-attachments', 'index.json'), 'utf8')) as { attachments: unknown[] };
    expect(index.attachments).toHaveLength(1);
    expect(attachments.get(first.artifact.id, first.attachment!.id)).not.toBeNull();
  });
});
