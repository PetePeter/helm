/**
 * SettingsScreen — grouped nav plus the gamepad pane model.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import { h, nextTick, ref } from 'vue';
import SettingsPane from '../../../renderer/components/settings/primitives/SettingsPane.vue';
import PillTabs from '../../../renderer/components/settings/primitives/PillTabs.vue';
import SettingsScreen from '../../../renderer/components/settings/SettingsScreen.vue';
import { SETTINGS_PAGES, resolveSettingsPage, stepSettingsPage } from '../../../renderer/components/settings/settings-registry.js';

let wrapper: VueWrapper | null = null;
afterEach(() => { wrapper?.unmount(); wrapper = null; });

/** A master/detail page: list pane, detail pane with sub-tab pills. */
const MASTER_DETAIL = () => [
  h(SettingsPane, null, () => [
    h('button', { class: 'focusable', id: 'row-1' }, 'one'),
    h('button', { class: 'focusable', id: 'row-2' }, 'two'),
  ]),
  h(SettingsPane, null, () => [
    h('button', { class: 'focusable', id: 'tab-a' }, 'A'),
    h('button', { class: 'focusable', id: 'tab-b' }, 'B'),
    h('input', { class: 'focusable', id: 'field' }),
  ]),
];

function mountScreen(activeTab = 'tools', slot = MASTER_DETAIL) {
  wrapper = mount(SettingsScreen, {
    props: { activeTab },
    slots: { default: slot },
    attachTo: document.body,
  });
  return wrapper;
}

const press = (w: VueWrapper, button: string) => (w.vm as unknown as { handleButton(b: string): boolean }).handleButton(button);

describe('settings registry', () => {
  it('maps legacy and unknown ids to a real page', () => {
    expect(resolveSettingsPage('profiles').id).toBe('tools');
    expect(resolveSettingsPage('nope').id).toBe('tools');
    expect(resolveSettingsPage('peers').id).toBe('peers');
  });

  it('steps through the nav order with wrap-around', () => {
    const last = SETTINGS_PAGES[SETTINGS_PAGES.length - 1].id;
    expect(stepSettingsPage('tools', -1)).toBe(last);
    expect(stepSettingsPage(last, 1)).toBe('tools');
  });
});

describe('SettingsScreen', () => {
  it('renders every page under its group, active one marked, no emoji', () => {
    const w = mountScreen('skills');
    expect(w.findAll('.settings-nav__group').map((g) => g.text())).toEqual(['Sessions', 'Knowledge', 'Connections', 'System']);
    const items = w.findAll('.settings-nav__item');
    expect(items).toHaveLength(SETTINGS_PAGES.length);
    expect(w.find('.settings-nav__item--active').text()).toBe('Skills');
    expect(w.find('.settings-nav').text()).not.toMatch(/\p{Extended_Pictographic}/u);
  });

  it('renders a registered page shortcut hint with the generic nav styling', () => {
    const w = mountScreen('dreaming');
    const dreaming = w.findAll('.settings-nav__item').find((item) => item.text().includes('Dreaming'))!;
    expect(dreaming.get('kbd').text()).toBe('Ctrl+Shift+G');
    expect(dreaming.get('kbd').classes()).toEqual(expect.arrayContaining(['dock-tab__shortcut', 'jump-key']));
  });

  it('clicking a nav item selects that page', async () => {
    const w = mountScreen();
    await w.findAll('.settings-nav__item')[2].trigger('click');
    expect(w.emitted('update:activeTab')).toEqual([[SETTINGS_PAGES[2].id]]);
  });

  it('up/down in the nav switches page', () => {
    const w = mountScreen('tools');
    press(w, 'DPadDown');
    press(w, 'DPadUp');
    expect(w.emitted('update:activeTab')).toEqual([[SETTINGS_PAGES[1].id], [SETTINGS_PAGES[SETTINGS_PAGES.length - 1].id]]);
  });

  it('right walks nav → list → detail, focusing the first item of each pane', () => {
    const w = mountScreen();
    press(w, 'DPadRight');
    expect(document.activeElement?.id).toBe('row-1');
    press(w, 'DPadRight');
    expect(document.activeElement?.id).toBe('tab-a');
    press(w, 'DPadRight');
    expect(document.activeElement?.id).toBe('tab-a');
  });

  it('A in the nav enters the first pane; A in a pane clicks the focused item', () => {
    let clicked = 0;
    const w = mountScreen('tools', () => [
      h(SettingsPane, null, () => [h('button', { class: 'focusable', id: 'go', onClick: () => clicked++ }, 'go')]),
    ]);
    press(w, 'A');
    expect(document.activeElement?.id).toBe('go');
    press(w, 'A');
    expect(clicked).toBe(1);
  });

  it('A on the focused Back button closes settings', () => {
    const w = mountScreen();
    const back = w.find('.settings-nav__back').element as HTMLButtonElement;
    back.focus();
    press(w, 'A');
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('A on a focused inactive nav item selects that page', () => {
    const w = mountScreen('tools');
    const inactive = w.findAll('.settings-nav__item')[1].element as HTMLButtonElement;
    inactive.focus();
    press(w, 'A');
    expect(w.emitted('update:activeTab')).toEqual([[SETTINGS_PAGES[1].id]]);
  });

  it('A on the focused active nav item enters the first content pane', () => {
    const w = mountScreen('tools', () => [
      h(SettingsPane, null, () => [h('button', { class: 'focusable', id: 'go' }, 'go')]),
    ]);
    w.find('.settings-nav__item--active').element.focus();
    press(w, 'A');
    expect(document.activeElement?.id).toBe('go');
  });

  it('up/down inside a pane moves focus within that pane only', () => {
    const w = mountScreen();
    press(w, 'DPadRight');
    press(w, 'DPadDown');
    expect(document.activeElement?.id).toBe('row-2');
    press(w, 'DPadDown');
    expect(document.activeElement?.id).toBe('row-1');
    expect(w.emitted('update:activeTab')).toBeUndefined();
  });

  it('B steps back detail → list → nav → close', () => {
    const w = mountScreen();
    press(w, 'DPadRight');
    press(w, 'DPadDown');
    press(w, 'DPadRight');
    press(w, 'B');
    expect(document.activeElement?.id).toBe('row-2');
    press(w, 'B');
    expect(document.activeElement?.classList.contains('settings-nav__item--active')).toBe(true);
    expect(w.emitted('close')).toBeUndefined();
    press(w, 'B');
    expect(w.emitted('close')).toHaveLength(1);
  });

  it('RB/LB step the page sub-tabs, wrapping around', async () => {
    const current = ref('b');
    const w = mountScreen('tools', () => [
      h(SettingsPane, null, () => [h(PillTabs, {
        tabs: ['a', 'b', 'c'].map((id) => ({ id, label: id })),
        modelValue: current.value,
        'onUpdate:modelValue': (id: string) => { current.value = id; },
      })]),
    ]);
    press(w, 'RightBumper');
    expect(current.value).toBe('c');
    await nextTick();
    press(w, 'RightBumper');
    expect(current.value).toBe('a');
    await nextTick();
    press(w, 'LeftBumper');
    expect(current.value).toBe('c');
  });

  it('a page that splits the body pane into columns gets those columns as panes', () => {
    const w = mountScreen('tools', () => [
      h(SettingsPane, null, () => [
        h(SettingsPane, null, () => [h('button', { class: 'focusable', id: 'l' })]),
        h(SettingsPane, null, () => [h('button', { class: 'focusable', id: 'd' })]),
      ]),
    ]);
    press(w, 'DPadRight');
    expect(document.activeElement?.id).toBe('l');
    press(w, 'DPadRight');
    expect(document.activeElement?.id).toBe('d');
  });

  it('keyboard arrows are left to a focused text field', () => {
    const w = mountScreen();
    press(w, 'DPadRight');
    press(w, 'DPadRight');
    const field = document.getElementById('field') as HTMLInputElement;
    field.focus();
    expect(press(w, 'ArrowLeft')).toBe(false);
    expect(document.activeElement).toBe(field);
  });
});
