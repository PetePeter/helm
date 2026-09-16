/**
 * NotificationCarousel tests — carousel navigation, dismiss, and edge cases.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick } from 'vue';
import NotificationCarousel from '../../../renderer/components/sidebar/NotificationCarousel.vue';

const NOTIFICATIONS = [
  { id: 'n1', title: 'First', content: 'Content one' },
  { id: 'n2', title: 'Second', content: 'Content two' },
  { id: 'n3', title: 'Third', content: 'Content three' },
];

describe('NotificationCarousel', () => {
  it('renders nothing when notifications is empty', () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: [], sessionId: 's1' },
    });
    expect(w.find('.notification-carousel').exists()).toBe(false);
  });

  it('renders title and content of first notification', () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS.slice(0, 1), sessionId: 's1' },
    });
    expect(w.find('.carousel-title').text()).toBe('First');
    expect(w.find('.carousel-text').text()).toBe('Content one');
  });

  it('hides nav arrows when only 1 notification', () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS.slice(0, 1), sessionId: 's1' },
    });
    expect(w.findAll('.nav-arrow')).toHaveLength(0);
  });

  it('shows nav arrows when > 1 notification', () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS, sessionId: 's1' },
    });
    expect(w.findAll('.nav-arrow')).toHaveLength(2);
    expect(w.findAll('.nav-arrow')[0].attributes('aria-label')).toBe('Previous notification');
    expect(w.findAll('.nav-arrow')[1].attributes('aria-label')).toBe('Next notification');
  });

  it('next click advances; prev click decrements', async () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS, sessionId: 's1' },
    });
    const arrows = w.findAll('.nav-arrow');

    // Next: index 0 -> 1
    await arrows[1].trigger('click');
    expect(w.find('.carousel-title').text()).toBe('Second');

    // Prev: index 1 -> 0
    await arrows[0].trigger('click');
    expect(w.find('.carousel-title').text()).toBe('First');
  });

  it('prev disabled at index 0; next disabled at last', () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS, sessionId: 's1' },
    });
    const arrows = w.findAll('.nav-arrow');

    // At index 0, prev (arrows[0]) is disabled, next (arrows[1]) is enabled
    expect(arrows[0].attributes('disabled')).toBeDefined();
    expect(arrows[1].attributes('disabled')).toBeUndefined();
  });

  it('next disabled at last index', async () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS, sessionId: 's1' },
    });
    const arrows = w.findAll('.nav-arrow');

    // Advance to last
    await arrows[1].trigger('click'); // 0 -> 1
    await arrows[1].trigger('click'); // 1 -> 2

    expect(arrows[1].attributes('disabled')).toBeDefined();
    expect(arrows[0].attributes('disabled')).toBeUndefined();
  });

  it('Dismiss emits dismiss with current notification id', async () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS, sessionId: 's1' },
    });

    await w.find('.dismiss-btn').trigger('click');
    expect(w.find('.dismiss-btn').attributes('aria-label')).toBe('Dismiss current notification');
    expect(w.emitted('dismiss')).toEqual([['n1']]);
  });

  it('after dismiss, currentIndex stays in bounds', async () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS, sessionId: 's1' },
    });

    // Advance to last (index 2)
    const arrows = w.findAll('.nav-arrow');
    await arrows[1].trigger('click');
    await arrows[1].trigger('click');
    expect(w.find('.carousel-title').text()).toBe('Third');

    // Dismiss the last item — emit fires but parent must remove the item
    await w.find('.dismiss-btn').trigger('click');
    expect(w.emitted('dismiss')).toEqual([['n3']]);

    // Simulate parent removing the notification (array shrinks from 3 to 2)
    await w.setProps({ notifications: NOTIFICATIONS.slice(0, 2) });
    await nextTick();

    // Index should have been clamped to 1, showing "Second"
    expect(w.find('.carousel-title').text()).toBe('Second');
  });

  it('clear button emits dismissAll with sessionId', async () => {
    const w = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS, sessionId: 's1' },
    });

    await w.find('.carousel-clear').trigger('click');
    expect(w.find('.carousel-clear').attributes('aria-label')).toBe('Clear all notifications');
    expect(w.emitted('dismissAll')).toEqual([['s1']]);
  });

  it('counter shown only when length > 1', () => {
    const single = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS.slice(0, 1), sessionId: 's1' },
    });
    expect(single.find('.carousel-counter').exists()).toBe(false);

    const multi = mount(NotificationCarousel, {
      props: { notifications: NOTIFICATIONS, sessionId: 's1' },
    });
    expect(multi.find('.carousel-counter').exists()).toBe(true);
    expect(multi.find('.carousel-counter').text()).toBe('1 / 3');
  });
});
