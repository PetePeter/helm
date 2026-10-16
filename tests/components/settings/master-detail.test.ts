/**
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import MasterDetail from '../../../renderer/components/settings/primitives/MasterDetail.vue';

const items = [
  { id: 'a', name: 'Claude Code', detail: 'claude', tag: 'CLI' },
  { id: 'b', name: 'Codex', detail: 'codex' },
];

function mountMd(modelValue: string | null) {
  return mount(MasterDetail, {
    props: { items, modelValue, listTitle: 'Tools' },
    slots: { detail: '<div class="probe">detail</div>' },
  });
}

describe('MasterDetail', () => {
  it('tints only the selected row and shows its detail', () => {
    const w = mountMd('b');
    const rows = w.findAll('.master-detail__row');
    expect(rows.map((r) => r.classes().includes('master-detail__row--active'))).toEqual([false, true]);
    expect(w.find('.probe').exists()).toBe(true);
  });

  it('clicking a row selects it', async () => {
    const w = mountMd('a');
    await w.findAll('.master-detail__row')[1].trigger('click');
    expect(w.emitted('update:modelValue')).toEqual([['b']]);
  });

  it('with nothing selected, prompts instead of rendering the detail', () => {
    const w = mountMd(null);
    expect(w.find('.probe').exists()).toBe(false);
    expect(w.text()).toContain('Select an item');
  });
});
