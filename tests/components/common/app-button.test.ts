/** @vitest-environment jsdom */
import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import AppButton from '../../../renderer/components/common/AppButton.vue';

describe('AppButton', () => {
  it.each(['primary', 'secondary', 'danger', 'ghost'] as const)(
    'applies the %s variant', variant => {
      const wrapper = mount(AppButton, { props: { variant } });

      expect(wrapper.element.tagName).toBe('BUTTON');
      expect(wrapper.classes()).toContain('app-button');
      expect(wrapper.classes()).toContain(`app-button--${variant}`);
    },
  );

  it.each(['sm', 'md'] as const)('applies the %s size variant', size => {
    const wrapper = mount(AppButton, { props: { size } });

    expect(wrapper.classes()).toContain(`app-button--${size}`);
  });

  it('forwards native attributes, focus classes, and slot content', () => {
    const wrapper = mount(AppButton, {
      props: { variant: 'secondary', size: 'sm' },
      attrs: {
        class: 'focusable',
        type: 'submit',
        disabled: true,
        'aria-label': 'Save changes',
      },
      slots: { default: 'Save' },
    });

    expect(wrapper.classes()).toContain('focusable');
    expect(wrapper.attributes('type')).toBe('submit');
    expect(wrapper.attributes('disabled')).toBeDefined();
    expect(wrapper.attributes('aria-label')).toBe('Save changes');
    expect(wrapper.text()).toBe('Save');
  });

  it('emits the native click event', async () => {
    const wrapper = mount(AppButton, { slots: { default: 'Run' } });

    await wrapper.trigger('click');

    expect(wrapper.emitted('click')).toHaveLength(1);
    expect(wrapper.emitted('click')?.[0]?.[0]).toBeInstanceOf(MouseEvent);
  });
});
