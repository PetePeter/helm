/**
 * ChipActionBar.vue — Alt+number accelerator badge + tooltip.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChipActionBar from '../../../renderer/components/chips/ChipActionBar.vue';

function makeActions(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    label: `Action ${i + 1}`,
    sequence: `seq${i + 1}{Enter}`,
    preview: `preview ${i + 1}`,
  }));
}

describe('ChipActionBar.vue', () => {
  it('renders an ⌥n accelerator badge for the first nine actions', () => {
    const w = mount(ChipActionBar, { props: { actions: makeActions(3) } });
    const badges = w.findAll('.chip-action-btn__accel');
    expect(badges.map(b => b.text())).toEqual(['⌥1', '⌥2', '⌥3']);
    w.unmount();
  });

  it('renders ⌥0 for the tenth action and no badge beyond it', () => {
    const w = mount(ChipActionBar, { props: { actions: makeActions(11) } });
    const badges = w.findAll('.chip-action-btn__accel');
    expect(badges.map(b => b.text())).toEqual(['⌥1', '⌥2', '⌥3', '⌥4', '⌥5', '⌥6', '⌥7', '⌥8', '⌥9', '⌥0']);
    w.unmount();
  });

  it('tooltip includes the Alt+N accelerator and preview', () => {
    const w = mount(ChipActionBar, { props: { actions: makeActions(1) } });
    const btn = w.find('.chip-action-btn');
    expect(btn.attributes('title')).toBe('Alt+1 — preview 1');
    w.unmount();
  });

  it('puts accelerator and label on row one and the preview on row two', () => {
    const w = mount(ChipActionBar, { props: { actions: makeActions(1) } });
    const top = w.find('.chip-action-btn__top');
    expect(top.find('.chip-action-btn__accel').text()).toBe('⌥1');
    expect(top.find('.chip-action-btn__label').text()).toBe('Action 1');
    expect(w.find('.chip-action-btn__preview').text()).toBe('preview 1');
    w.unmount();
  });

  it('emits the action sequence on click', async () => {
    const w = mount(ChipActionBar, { props: { actions: makeActions(2) } });
    await w.findAll('.chip-action-btn')[1].trigger('click');
    expect(w.emitted('actionClick')?.[0]).toEqual(['seq2{Enter}']);
    w.unmount();
  });
});
