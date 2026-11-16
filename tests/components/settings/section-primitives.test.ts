/**
 * Shared settings primitives — accessible headings and controlled toggle rows.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import SectionHeader from '../../../renderer/components/settings/primitives/SectionHeader.vue';
import ToggleRow from '../../../renderer/components/settings/primitives/ToggleRow.vue';

describe('SectionHeader', () => {
  it('renders a section heading and its optional actions', () => {
    const wrapper = mount(SectionHeader, {
      props: { title: 'Network' },
      slots: { actions: '<button type="button">Pair</button>' },
    });

    expect(wrapper.get('h3').text()).toBe('Network');
    expect(wrapper.get('button').text()).toBe('Pair');
  });

  it('supports a lower heading level inside nested sections', () => {
    const wrapper = mount(SectionHeader, { props: { title: 'Paired peers', level: 4 } });

    expect(wrapper.get('h4').text()).toBe('Paired peers');
  });
});

describe('ToggleRow', () => {
  it('renders its hint and emits the changed v-model value', async () => {
    const wrapper = mount(ToggleRow, {
      props: { label: 'Enable reminders', modelValue: false },
      slots: { hint: 'Runs after each turn.' },
    });

    expect(wrapper.text()).toContain('Enable reminders');
    expect(wrapper.text()).toContain('Runs after each turn.');
    await wrapper.get('input').setValue(true);
    expect(wrapper.emitted('update:modelValue')).toEqual([[true]]);
  });

  it('passes disabled state to the checkbox', () => {
    const wrapper = mount(ToggleRow, {
      props: { label: 'Enable reminders', modelValue: false, disabled: true },
    });

    expect((wrapper.get('input').element as HTMLInputElement).disabled).toBe(true);
  });
});
