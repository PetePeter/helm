// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import PanelHeader from '../../../renderer/components/common/PanelHeader.vue';
import SearchField from '../../../renderer/components/common/SearchField.vue';
import ListRow from '../../../renderer/components/common/ListRow.vue';
import FilterChip from '../../../renderer/components/common/FilterChip.vue';
import EmptyState from '../../../renderer/components/common/EmptyState.vue';

describe('shared UI primitives', () => {
  it('renders PanelHeader anatomy and only includes the toolbar when provided', () => {
    const withoutToolbar = mount(PanelHeader, {
      props: { title: 'Artifacts', subtitle: 'Recent', icon: '📦' },
      slots: { actions: '<button type="button">Refresh</button>' },
    });

    expect(withoutToolbar.element.tagName).toBe('HEADER');
    expect(withoutToolbar.find('h2').text()).toBe('Artifacts');
    expect(withoutToolbar.find('[aria-hidden="true"]').text()).toBe('📦');
    expect(withoutToolbar.text()).toContain('Recent');
    expect(withoutToolbar.text()).toContain('Refresh');
    expect(withoutToolbar.find('.panel-header__toolbar').exists()).toBe(false);

    const withToolbar = mount(PanelHeader, {
      props: { title: 'Plans' },
      slots: { toolbar: '<label>Search</label>' },
    });
    expect(withToolbar.find('.panel-header__toolbar').text()).toBe('Search');
  });

  it('emits SearchField model updates and exposes an accessible search name', async () => {
    const wrapper = mount(SearchField, {
      props: { modelValue: '', placeholder: 'Find artifacts' },
    });
    const input = wrapper.find('input[type="search"]');

    expect(input.attributes('aria-label')).toBe('Find artifacts');
    await input.setValue('draft');
    expect(wrapper.emitted('update:modelValue')).toEqual([['draft']]);
  });

  it('uses the explicit SearchField accessible label when supplied', () => {
    const wrapper = mount(SearchField, {
      props: { modelValue: '', placeholder: 'Find artifacts', ariaLabel: 'Artifact search' },
    });

    expect(wrapper.find('input').attributes('aria-label')).toBe('Artifact search');
  });

  it('renders ListRow as an activated button and marks the selected row', async () => {
    const wrapper = mount(ListRow, {
      props: { selected: true, unread: true },
      slots: { title: 'Artifact one', meta: 'Updated now' },
    });
    const button = wrapper.find('button');

    expect(button.attributes('type')).toBe('button');
    expect(button.attributes('aria-current')).toBe('true');
    expect(wrapper.text()).toContain('Artifact one');
    expect(wrapper.text()).toContain('Updated now');
    await button.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
  });

  it.each([
    ['yes', 'true'],
    ['no', 'false'],
    ['either', 'mixed'],
  ] as const)('maps FilterChip state %s to aria-pressed=%s', (state, ariaPressed) => {
    const wrapper = mount(FilterChip, { props: { state, label: 'Unread' } });

    expect(wrapper.find('button').attributes('aria-pressed')).toBe(ariaPressed);
  });

  it('cycles FilterChip through either, yes, no, and back to either', async () => {
    const wrapper = mount(FilterChip, { props: { state: 'either', label: 'Unread' } });
    const button = wrapper.find('button');

    await button.trigger('click');
    await wrapper.setProps({ state: 'yes' });
    await button.trigger('click');
    await wrapper.setProps({ state: 'no' });
    await button.trigger('click');

    expect(wrapper.emitted('update:state')).toEqual([['yes'], ['no'], ['either']]);
  });

  it('renders EmptyState loading as a status and ignores its icon and action', () => {
    const wrapper = mount(EmptyState, {
      props: { title: 'Memories', hint: 'Loading records', icon: '🧠', loading: true },
      slots: { action: '<button type="button">Create</button>' },
    });

    expect(wrapper.find('[role="status"]').exists()).toBe(true);
    expect(wrapper.find('[role="status"]').text()).toContain('Memories');
    expect(wrapper.find('[aria-hidden="true"]').exists()).toBe(true);
    expect(wrapper.text()).not.toContain('🧠');
    expect(wrapper.find('button').exists()).toBe(false);
  });

  it('supports compact EmptyState sizing for inline empty content', () => {
    const wrapper = mount(EmptyState, {
      props: { title: 'No schedules yet', hint: 'Create a schedule to run a prompt.', compact: true },
    });

    expect(wrapper.classes()).toContain('empty-state--compact');
    expect(wrapper.find('h3').text()).toBe('No schedules yet');
    expect(wrapper.find('p').text()).toBe('Create a schedule to run a prompt.');
  });
});
