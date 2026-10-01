import { describe, it, expect, beforeEach } from 'vitest';
import { ArtifactManager } from '../src/session/artifact-manager.js';
import type { Artifact } from '../src/types/artifact.js';

/** Deterministic increasing clock. Each read returns the next value. */
function makeClock(start = 1000, step = 10): () => number {
  let t = start;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

describe('ArtifactManager', () => {
  let persisted: Record<string, Artifact[]> | null;
  let persistCalls: number;
  let manager: ArtifactManager;
  let clock: () => number;

  const capturePersist = (all: Record<string, Artifact[]>) => {
    persistCalls += 1;
    persisted = all;
  };

  beforeEach(() => {
    persisted = null;
    persistCalls = 0;
    clock = makeClock();
    manager = new ArtifactManager(capturePersist, clock);
  });

  it('create() creates v1 with correct id/sessionId/title/kind and one version', () => {
    const art = manager.create('s1', 'Report', 'markdown', '# hi');
    expect(art.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(art.sessionId).toBe('s1');
    expect(art.title).toBe('Report');
    expect(art.kind).toBe('markdown');
    expect(art.versions).toHaveLength(1);
    expect(art.versions[0]).toEqual({ version: 1, content: '# hi', createdAt: 1000 });
    expect(manager.get(art.id)).not.toBeNull();
  });

  it('create() with duplicate titles yields two distinct artifacts', () => {
    const first = manager.create('s1', 'Report', 'markdown', 'v1');
    const second = manager.create('s1', 'Report', 'markdown', 'v2');

    expect(second.id).not.toBe(first.id);
    expect(manager.getForSession('s1')).toHaveLength(2);
    // each is its own version-1 artifact
    expect(first.versions.map(v => v.version)).toEqual([1]);
    expect(second.versions.map(v => v.version)).toEqual([1]);
    expect(first.versions[0].content).toBe('v1');
    expect(second.versions[0].content).toBe('v2');
  });

  it('create() with same title but different session creates a separate artifact', () => {
    const a = manager.create('s1', 'Report', 'markdown', 'a');
    const b = manager.create('s2', 'Report', 'markdown', 'b');

    expect(b.id).not.toBe(a.id);
    expect(manager.getForSession('s1')).toHaveLength(1);
    expect(manager.getForSession('s2')).toHaveLength(1);
    expect(manager.getForSession('s2')[0].versions[0].content).toBe('b');
  });

  it('update() appends a new incremented version; returns null for unknown id', () => {
    const art = manager.create('s1', 'Doc', 'html', '<p>1</p>');
    const updated = manager.update(art.id, '<p>2</p>');

    expect(updated).not.toBeNull();
    expect(updated!.versions).toHaveLength(2);
    expect(updated!.versions[1]).toMatchObject({ version: 2, content: '<p>2</p>' });
    expect(manager.update('nope', 'x')).toBeNull();
  });

  it('retains prior versions in order after multiple updates', () => {
    const art = manager.create('s1', 'Doc', 'markdown', 'one');
    manager.update(art.id, 'two');
    manager.update(art.id, 'three');

    const stored = manager.get(art.id)!;
    expect(stored.versions.map(v => v.version)).toEqual([1, 2, 3]);
    expect(stored.versions.map(v => v.content)).toEqual(['one', 'two', 'three']);
  });

  it('delete() removes one artifact and returns false for unknown id', () => {
    const art = manager.create('s1', 'Doc', 'markdown', 'x');
    expect(manager.delete(art.id)).toBe(true);
    expect(manager.get(art.id)).toBeNull();
    expect(manager.count('s1')).toBe(0);
    expect(manager.delete('unknown')).toBe(false);
  });

  it('deleteAllForSession()/clearSession() removes only that session', () => {
    manager.create('s1', 'A', 'markdown', '1');
    manager.create('s1', 'B', 'markdown', '2');
    manager.create('s2', 'C', 'markdown', '3');

    manager.deleteAllForSession('s1');
    expect(manager.count('s1')).toBe(0);
    expect(manager.count('s2')).toBe(1);

    manager.create('s3', 'D', 'markdown', '4');
    manager.clearSession('s3');
    expect(manager.count('s3')).toBe(0);
    expect(manager.count('s2')).toBe(1);
  });

  it('getForSession() returns newest-updated first and is isolated per session', () => {
    const a = manager.create('s1', 'A', 'markdown', '1');
    const b = manager.create('s1', 'B', 'markdown', '2');
    // touch A so it becomes most-recently-updated
    manager.update(a.id, '1b');

    const list = manager.getForSession('s1');
    expect(list.map(x => x.id)).toEqual([a.id, b.id]);
    expect(manager.getForSession('other')).toEqual([]);
  });

  it('invokes persist and emits artifact:changed with sessionId on every mutation', () => {
    const events: string[] = [];
    manager.on('artifact:changed', (sid: string) => events.push(sid));

    const art = manager.create('s1', 'A', 'markdown', '1'); // 1
    manager.update(art.id, '2'); // 2
    manager.delete(art.id); // 3
    manager.create('s2', 'B', 'html', 'x'); // 4
    manager.clearSession('s2'); // 5

    expect(persistCalls).toBe(5);
    expect(persisted).not.toBeNull();
    expect(events).toEqual(['s1', 's1', 's1', 's2', 's2']);
  });

  it('create() and update() emit artifact:reveal with sessionId and artifactId', () => {
    const reveals: Array<[string, string]> = [];
    manager.on('artifact:reveal', (sid: string, aid: string) => reveals.push([sid, aid]));

    const art = manager.create('s1', 'A', 'markdown', '1');
    manager.update(art.id, '2');

    expect(reveals).toEqual([
      ['s1', art.id],
      ['s1', art.id],
    ]);
  });

  it('reveal() emits artifact:reveal and returns true; false for unknown id', () => {
    const art = manager.create('s1', 'A', 'markdown', '1');
    const reveals: Array<[string, string]> = [];
    manager.on('artifact:reveal', (sid: string, aid: string) => reveals.push([sid, aid]));

    expect(manager.reveal(art.id)).toBe(true);
    expect(reveals).toEqual([['s1', art.id]]);
    // reveal does not mutate: still one version, no persist triggered
    expect(manager.get(art.id)!.versions).toHaveLength(1);

    expect(manager.reveal('unknown')).toBe(false);
    expect(reveals).toHaveLength(1);
  });

  it('injected clock drives createdAt/updatedAt', () => {
    // clock: 1000, 1010, 1020, ...
    const art = manager.create('s1', 'A', 'markdown', '1');
    expect(art.createdAt).toBe(1000);
    expect(art.updatedAt).toBe(1000);
    expect(art.versions[0].createdAt).toBe(1000);

    const updated = manager.update(art.id, '2')!;
    expect(updated.updatedAt).toBe(1010);
    expect(updated.versions[1].createdAt).toBe(1010);
    expect(updated.createdAt).toBe(1000); // unchanged
  });

  it('exportAll/importAll round-trips artifacts', () => {
    manager.create('s1', 'A', 'markdown', '1');
    manager.create('s2', 'B', 'html', '2');
    const exported = manager.exportAll();

    const fresh = new ArtifactManager(undefined, makeClock());
    fresh.importAll(exported);
    expect(fresh.count('s1')).toBe(1);
    expect(fresh.count('s2')).toBe(1);
    expect(fresh.getForSession('s1')[0].versions[0].content).toBe('1');
  });

  it('create() with source param stores the source on the artifact', () => {
    const art = manager.create('s1', 'Note', 'markdown', 'text', 'manual');
    expect(art.source).toBe('manual');
    expect(manager.get(art.id)!.source).toBe('manual');
  });

  it('create() without source defaults to undefined (backward compat)', () => {
    const art = manager.create('s1', 'Report', 'markdown', 'ai text');
    expect(art.source).toBeUndefined();
  });

  it('rename() changes title and bumps updatedAt', () => {
    const art = manager.create('s1', 'Old Title', 'markdown', 'x');
    expect(manager.rename(art.id, 'New Title')).toBe(true);
    const updated = manager.get(art.id)!;
    expect(updated.title).toBe('New Title');
    expect(updated.updatedAt).toBe(1010); // clock advanced on rename
  });

  it('rename() returns false for unknown id', () => {
    expect(manager.rename('nonexistent', 'New')).toBe(false);
  });

  it('delete() invokes onDelete callback with artifactId', () => {
    const deletedIds: string[] = [];
    const onDeleteManager = new ArtifactManager(capturePersist, clock, (id) => deletedIds.push(id));
    const art = onDeleteManager.create('s1', 'A', 'markdown', 'x');
    onDeleteManager.delete(art.id);
    expect(deletedIds).toEqual([art.id]);
  });

  it('deleteAllForSession() invokes onDelete for every artifact', () => {
    const deletedIds: string[] = [];
    const onDeleteManager = new ArtifactManager(capturePersist, clock, (id) => deletedIds.push(id));
    const first = onDeleteManager.create('s1', 'A', 'markdown', 'x');
    const second = onDeleteManager.create('s1', 'B', 'markdown', 'y');

    onDeleteManager.deleteAllForSession('s1');

    expect(deletedIds).toEqual([first.id, second.id]);
  });

  describe('copySession()', () => {
    it('copies every artifact to the target under new ids, keeping versions and leaving the source alone', () => {
      const report = manager.create('s1', 'Report', 'markdown', '# v1');
      manager.update(report.id, '# v2');
      manager.create('s1', 'Page', 'html', '<p>hi</p>');
      const events: Array<[string, string[]]> = [];
      manager.on('artifact:changed', (sid: string, ids: string[]) => events.push([sid, ids]));

      const pairs = manager.copySession('s1', 's2');

      const copies = manager.getForSession('s2');
      expect(copies).toHaveLength(2);
      expect(pairs.map(p => p.to).sort()).toEqual(copies.map(c => c.id).sort());
      for (const { from, to } of pairs) {
        const original = manager.get(from)!;
        const copy = manager.get(to)!;
        expect(to).not.toBe(from);
        expect(copy).toMatchObject({ sessionId: 's2', title: original.title, kind: original.kind });
        expect(copy.versions.map(v => v.content)).toEqual(original.versions.map(v => v.content));
        expect(original.sessionId).toBe('s1');
      }
      expect(manager.count('s1')).toBe(2);
      expect(Object.keys(persisted!).sort()).toEqual(['s1', 's2']);
      expect(events).toHaveLength(1);
      expect(events[0][0]).toBe('s2');
      expect([...events[0][1]].sort()).toEqual(copies.map(c => c.id).sort());
    });

    it('points copied content at the new artifact id, so attachment paths follow the copy', () => {
      const original = manager.create('s1', 'Shots', 'markdown', 'placeholder');
      manager.update(original.id, `![a](C:/cfg/artifact-attachments/${original.id}/img.png)`);

      const [{ to }] = manager.copySession('s1', 's2');

      const copy = manager.get(to)!;
      expect(copy.versions[1].content).toBe(`![a](C:/cfg/artifact-attachments/${to}/img.png)`);
      expect(copy.versions[0].content).toBe('placeholder');
    });

    it('is a no-op for a session with no artifacts', () => {
      expect(manager.copySession('empty', 's2')).toEqual([]);
      expect(persistCalls).toBe(0);
    });
  });
});

