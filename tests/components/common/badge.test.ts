/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import Badge from '../../../renderer/components/common/Badge.vue';

describe('Badge', () => {
  it('defaults to neutral and does not flash', () => {
    const wrapper = mount(Badge);

    expect(wrapper.classes()).toContain('badge--neutral');
    expect(wrapper.classes()).not.toContain('badge--count');
    expect(wrapper.classes()).not.toContain('badge--flashing');
  });

  it('applies the count size variant', () => {
    const wrapper = mount(Badge, { props: { size: 'count' } });

    expect(wrapper.classes()).toContain('badge--count');
  });

  it('renders as a button and forwards button attributes when requested', () => {
    const wrapper = mount(Badge, {
      props: { as: 'button' },
      attrs: { disabled: true, 'aria-label': 'Copy address' },
      slots: { default: 'Copy' },
    });

    expect(wrapper.element.tagName).toBe('BUTTON');
    expect(wrapper.attributes('type')).toBe('button');
    expect(wrapper.attributes('disabled')).toBeDefined();
    expect(wrapper.attributes('aria-label')).toBe('Copy address');
    expect(wrapper.text()).toBe('Copy');
  });

  it.each(['accent', 'ok', 'warn', 'error', 'neutral'] as const)(
    'maps the %s tone to its class',
    tone => {
      const wrapper = mount(Badge, { props: { tone }, slots: { default: 'Status' } });

      expect(wrapper.classes()).toContain(`badge--${tone}`);
      expect(wrapper.text()).toBe('Status');
    },
  );

  it('applies flashing and forwards classes and attributes to its root', () => {
    const wrapper = mount(Badge, {
      props: { flashing: true },
      attrs: { class: 'compact-badge', title: 'Unread count', 'data-test': 'badge' },
      slots: { default: '3' },
    });

    expect(wrapper.classes()).toContain('badge--flashing');
    expect(wrapper.classes()).toContain('compact-badge');
    expect(wrapper.attributes('title')).toBe('Unread count');
    expect(wrapper.attributes('data-test')).toBe('badge');
    expect(wrapper.text()).toBe('3');
  });
});
