import { describe, expect, it } from 'vitest';
import { groupTasks, matchesFilter, matchesSearch, tintFor } from '../renderer/user-tasks/user-task-board.js';
import type { UserTask } from '../src/types/user-task.js';

const task = (over: Partial<UserTask>): UserTask => ({
  id: over.title ?? 'id', title: 't', body: '', author: { kind: 'user' }, urgent: false,
  attachments: [], createdAt: 1, updatedAt: 1, ...over,
});

describe('user task board', () => {
  const mine = task({ title: 'mine' });
  const ai = task({ title: 'ai', author: { kind: 'ai', name: 'helm-core' }, projectId: 'p1', urgent: true });
  const done = task({ title: 'done', doneAt: 5 });

  it('filters by author, urgency and done, never mixing done into open views', () => {
    const all = [mine, ai, done];
    expect(all.filter(t => matchesFilter(t, 'all')).map(t => t.title)).toEqual(['mine', 'ai']);
    expect(all.filter(t => matchesFilter(t, 'mine')).map(t => t.title)).toEqual(['mine']);
    expect(all.filter(t => matchesFilter(t, 'ai')).map(t => t.title)).toEqual(['ai']);
    expect(all.filter(t => matchesFilter(t, 'urgent')).map(t => t.title)).toEqual(['ai']);
    expect(all.filter(t => matchesFilter(t, 'done')).map(t => t.title)).toEqual(['done']);
  });

  it('searches title, body, author and attachment titles', () => {
    expect(matchesSearch(ai, 'HELM-core')).toBe(true);
    expect(matchesSearch(task({ body: 'check the cable' }), 'cable')).toBe(true);
    expect(matchesSearch(mine, 'zzz')).toBe(false);
  });

  it('groups by project with General last, and by author', () => {
    const cols = groupTasks([mine, ai], 'project', id => (id === 'p1' ? 'Helm' : undefined));
    expect(cols.map(c => [c.label, c.tasks.length])).toEqual([['Helm', 1], ['General', 1]]);
    expect(cols[1].tint).toBe(0);
    expect(cols[0].tint).toBe(tintFor('p1'));
    expect(groupTasks([mine, ai], 'author', () => undefined).map(c => c.label)).toEqual(['helm-core', 'You']);
  });
});
