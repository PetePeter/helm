/**
 * ChipbarActionsTab.vue — two-click delete confirm robustness.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import ChipbarActionsTab from '../../../renderer/components/settings/pages/ChipbarActionsTab.vue';

const ACTIONS = [
  { label: 'One', sequence: 'one{Enter}' },
  { label: 'Two', sequence: 'two{Enter}' },
];

function deleteButton(w: ReturnType<typeof mount>, index: number) {
  return w.findAll('.settings-list-item')[index].find('.btn--danger');
}

describe('ChipbarActionsTab.vue delete confirm', () => {
  it('first click arms confirm, second click emits delete', async () => {
    const w = mount(ChipbarActionsTab, { props: { actions: ACTIONS } });
    const btn = deleteButton(w, 0);

    await btn.trigger('click');
    expect(btn.text()).toBe('Confirm?');
    expect(w.emitted('delete')).toBeUndefined();

    await btn.trigger('click');
    expect(w.emitted('delete')?.[0]).toEqual([0]);
    w.unmount();
  });

});
