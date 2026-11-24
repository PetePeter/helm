/**
 * User task detail — checklist ticking, adding, and the back-to-listing flow.
 *
 * @vitest-environment jsdom
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { flushPromises, mount } from '@vue/test-utils';
import type { UserTask } from '../src/types/user-task.js';

const store = { check: vi.fn(async () => ({})), update: vi.fn(async () => ({})), remove: vi.fn(), readAttachment: vi.fn(), openAttachment: vi.fn() };
vi.mock('../renderer/stores/user-tasks.js', () => ({ useUserTasksStore: () => store }));
vi.mock('../renderer/composables/useRecycleBin.js', () => ({
  useRecycleBin: () => ({ entries: { value: [] }, ensureSubscribed: vi.fn(), restore: vi.fn() }),
}));

const { default: UserTaskDetail } = await import('../renderer/components/dock/UserTaskDetail.vue');

const task = (over: Partial<UserTask> = {}): UserTask => ({
  id: 't1', title: 'Test pairing', body: 'short', author: { kind: 'user' }, urgent: false, attachments: [],
  checklist: [{ id: 'a', text: 'Install', doneAt: 5 }, { id: 'b', text: 'Scan' }], createdAt: 1, updatedAt: 1, ...over,
});
const mountDetail = (t = task()) => mount(UserTaskDetail, { props: { task: t, projectName: 'helm', tint: 2 } });

describe('UserTaskDetail', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
  });

  it('shows progress, ticks an item, and appends a new one keeping existing ids', async () => {
    const w = mountDetail();
    expect(w.find('.utd__count').text()).toBe('1 / 2');
    expect(w.find('.utd__dot--t2').exists()).toBe(true);
    await w.findAll('.utd__item-check')[1].setValue(true);
    expect(store.check).toHaveBeenCalledWith('t1', 'b', true);
    await w.find('.utd__add input').setValue('Revoke');
    await w.find('.utd__add').trigger('submit');
    await flushPromises();
    expect(store.update).toHaveBeenCalledWith('t1', { checklist: [{ id: 'a', text: 'Install' }, { id: 'b', text: 'Scan' }, { text: 'Revoke' }] });
  });

  it('renames an item inline on blur without entering Edit', async () => {
    const w = mountDetail();
    const input = w.findAll('.utd__item-text')[1];
    await input.setValue('Scan the QR');
    await input.trigger('blur');
    await flushPromises();
    expect(store.update).toHaveBeenCalledWith('t1', { checklist: [{ id: 'a', text: 'Install' }, { id: 'b', text: 'Scan the QR' }] });
  });

  it('pulses Done only when every item is ticked, and the back link closes', async () => {
    expect(mountDetail().find('.utd__done--ready').exists()).toBe(false);
    const w = mountDetail(task({ checklist: [{ id: 'a', text: 'x', doneAt: 1 }] }));
    expect(w.find('.utd__done--ready').exists()).toBe(true);
    await w.find('.utd__back').trigger('click');
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('clamps a long description behind Show more', async () => {
    const w = mountDetail(task({ body: 'line\n'.repeat(20) }));
    expect(w.find('.utd__text--clamp').exists()).toBe(true);
    await w.find('.utd__more').trigger('click');
    expect(w.find('.utd__text--clamp').exists()).toBe(false);
  });
});
