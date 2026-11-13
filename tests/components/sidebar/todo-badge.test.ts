/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import TodoBadge from '../../../renderer/components/sidebar/TodoBadge.vue';
import type { SessionTodo } from '../../../src/types/todo';

function todo(n: number, status: SessionTodo['status'] = 'open'): SessionTodo {
  return { id: `t${n}`, text: `item ${n}`, status, createdAt: n };
}

const popover = () => document.body.querySelector('.todo-badge__popover');
let wrapper: VueWrapper | null = null;

function mountBadge(todos: SessionTodo[]) {
  wrapper = mount(TodoBadge, { props: { todos }, attachTo: document.body });
  return wrapper;
}

afterEach(() => { wrapper?.unmount(); wrapper = null; });

describe('TodoBadge', () => {
  it('shows the pending todos in order on hover, waiting ones marked', async () => {
    const w = mountBadge([todo(1), todo(2, 'waiting')]);
    expect(w.get('.session-todo-count').text()).toBe('2');
    expect(popover()).toBeNull();

    await w.get('.session-todo-count').trigger('mouseenter');
    const rows = [...popover()!.querySelectorAll('.todo-badge__item')].map(row => row.textContent?.trim());
    expect(rows).toEqual(['item 1', '⏸ item 2']);
  });

  it('caps the list and says how many more there are', async () => {
    const w = mountBadge(Array.from({ length: 11 }, (_, i) => todo(i + 1)));
    await w.get('.session-todo-count').trigger('mouseenter');
    expect(popover()!.querySelectorAll('.todo-badge__item')).toHaveLength(8);
    expect(popover()!.querySelector('.todo-badge__more')?.textContent?.trim()).toBe('+3 more');
  });

  it('opens on keyboard focus and hides on leave or blur', async () => {
    const w = mountBadge([todo(1)]);
    const badge = w.get('.session-todo-count');
    await badge.trigger('focus');
    expect(popover()).not.toBeNull();
    await badge.trigger('blur');
    expect(popover()).toBeNull();
    await badge.trigger('mouseenter');
    await badge.trigger('mouseleave');
    expect(popover()).toBeNull();
  });

  it('renders nothing without todos', () => {
    expect(mountBadge([]).find('.session-todo-count').exists()).toBe(false);
  });
});
