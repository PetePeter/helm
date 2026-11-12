// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { mount } from '@vue/test-utils';
import { nextTick, ref } from 'vue';
import TemplateFieldInput from '../../../renderer/components/settings/tools/TemplateFieldInput.vue';
import type { TemplateField } from '../../../src/config/template-placeholders';

let wrapper: ReturnType<typeof mount> | undefined;
afterEach(() => { wrapper?.unmount(); wrapper = undefined; });

function mountField(field: TemplateField, initial: string) {
  const value = ref(initial);
  wrapper = mount(TemplateFieldInput, {
    props: { field, inputId: 'f', label: 'Field', modelValue: value.value, 'onUpdate:modelValue': (v: string) => { value.value = v; wrapper!.setProps({ modelValue: v }); } },
    attachTo: document.body,
  });
  return { w: wrapper, value };
}

describe('TemplateFieldInput', () => {
  it('placeholder help lists every placeholder of the field and inserts one at the cursor', async () => {
    const { w, value } = mountField('resumeCommand', 'claude --resume=');
    await w.find('.tf__help').trigger('click');
    const rows = w.findAll('.tf__row');
    expect(rows.map(r => r.find('code').text())).toEqual(['{cliSessionName}', '{cliThreadId}']);
    expect(w.text()).not.toContain('Keys (sequence syntax)');

    (w.find('input').element as HTMLInputElement).setSelectionRange(16, 16);
    await rows[1].trigger('click');
    expect(value.value).toBe('claude --resume={cliThreadId}');
  });

  it('sequence fields also list the keys', async () => {
    const { w } = mountField('compact', '');
    await w.find('.tf__help').trigger('click');
    expect(w.text()).toContain('{instruction}');
    expect(w.text()).toContain('{Enter}');
    expect(w.text()).toContain('{Wait 500}');
  });

  it('a typo shows the red warning; fixing it clears the warning', async () => {
    const { w } = mountField('resumeCommand', 'claude --resume={cliThreadID}');
    expect(w.find('.tf__warn').text()).toContain('{cliThreadID}');
    expect(w.find('input').classes()).toContain('tf__input--bad');

    await w.find('input').setValue('claude --resume={cliThreadId}');
    await nextTick();
    expect(w.find('.tf__warn').exists()).toBe(false);
  });
});
