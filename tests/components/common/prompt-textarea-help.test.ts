/**
 * PromptTextarea placeholder help — the same key list as the Tool editor,
 * click-to-insert at the cursor.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import PromptTextarea from '../../../renderer/components/common/PromptTextarea.vue';
import { SEQUENCE_KEY_HELP } from '../../../src/config/template-placeholders';

describe('PromptTextarea placeholder help', () => {
  it('lists every sequence key and inserts the picked one at the cursor', async () => {
    const w = mount(PromptTextarea, { props: { modelValue: 'ab' }, attachTo: document.body });
    const el = w.get('textarea').element as HTMLTextAreaElement;
    el.setSelectionRange(1, 1);

    await w.get('.ph-help__btn').trigger('click');
    const rows = w.findAll('.ph-help__row');
    expect(rows.map(row => row.get('code').text())).toEqual(SEQUENCE_KEY_HELP.map(k => k.token));

    await rows.find(row => row.get('code').text() === '{Enter}')!.trigger('click');
    expect(w.emitted('update:modelValue')?.at(-1)).toEqual(['a{Enter}b']);
    w.unmount();
  });

  it('closes on Escape', async () => {
    const w = mount(PromptTextarea, { props: { modelValue: '' }, attachTo: document.body });
    await w.get('.ph-help__btn').trigger('click');
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await w.vm.$nextTick();
    expect(w.find('.ph-help__pop').exists()).toBe(false);
    w.unmount();
  });
});
