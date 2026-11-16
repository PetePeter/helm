/** @vitest-environment jsdom */

import { describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import DockViewMenu from '../../../renderer/components/dock/DockViewMenu.vue';

const items = [
  { id: 'terminal', title: 'Terminal', icon: '▶', closed: false },
  { id: 'artifacts', title: 'Artifacts', icon: '📄', closed: true },
] as const;

describe('DockViewMenu', () => {
  it('separates closed panes from open ones so recovery is findable', async () => {
    const wrapper = mount(DockViewMenu, { props: { open: true, items } });
    const buttons = wrapper.findAll('[role="menuitemcheckbox"]');

    expect(buttons.map(button => button.get('.dock-view-menu__label').text())).toEqual(['Terminal', 'Artifacts']);
    expect(buttons[0].attributes('aria-checked')).toBe('true');
    expect(buttons[1].attributes('aria-checked')).toBe('false');
    expect(buttons[1].classes()).toContain('dock-view-menu__item--closed');
    expect(wrapper.findAll('.dock-view-menu__heading').map(h => h.text())).toEqual(['Open panes', 'Closed panes']);

    await buttons[1].trigger('click');
    await wrapper.get('.dock-view-menu__reset').trigger('click');
    expect(wrapper.emitted('toggle')).toEqual([['artifacts']]);
    expect(wrapper.emitted('reset')).toEqual([[]]);
  });

  it('badges the trigger with the number of recoverable panes', () => {
    const wrapper = mount(DockViewMenu, { props: { open: false, items } });
    expect(wrapper.get('.dock-view-menu__badge').text()).toBe('1');

    const allOpen = mount(DockViewMenu, {
      props: { open: false, items: items.map(item => ({ ...item, closed: false })) },
    });
    expect(allOpen.find('.dock-view-menu__badge').exists()).toBe(false);
  });

  it('renders app actions as styled menu rows after the layout items, closing before running', async () => {
    const calls: string[] = [];
    const wrapper = mount(DockViewMenu, {
      props: {
        open: true, items, label: '☰',
        actions: [{ icon: '⚙', label: 'Settings', run: () => calls.push('settings') }],
        'onClose': () => calls.push('close'),
      },
    });
    expect(wrapper.get('.dock-view-menu__trigger').text()).toContain('☰');
    const rows = wrapper.findAll('[role="menuitem"]');
    expect(rows.map(item => item.text())).toEqual(['Reset Layout', '⚙Settings']);
    expect(rows[1].classes()).toContain('dock-view-menu__item');
    await rows[1].trigger('click');
    expect(calls).toEqual(['close', 'settings']);
  });

  it('opens and closes from the accessible trigger', async () => {
    const wrapper = mount(DockViewMenu, { props: { open: false, items } });

    await wrapper.get('.dock-view-menu__trigger').trigger('click');
    expect(wrapper.emitted('open')).toEqual([[]]);
    await wrapper.setProps({ open: true });
    await wrapper.get('.dock-view-menu__trigger').trigger('click');
    expect(wrapper.emitted('close')).toEqual([[]]);
  });
});
