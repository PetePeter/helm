// @vitest-environment jsdom
/**
 * RuntimeGroupNameModal — creating a group picks its colour just like renaming
 * does (the same picker), so a new group never starts uncoloured by accident.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import RuntimeGroupNameModal from '../../../renderer/components/modals/RuntimeGroupNameModal.vue';
import { RUNTIME_GROUP_COLORS } from '../../../src/types/runtime-group.js';

let w: VueWrapper | null = null;
afterEach(() => { w?.unmount(); w = null; });

describe('RuntimeGroupNameModal', () => {
  it('create mode shows the colour picker and submits the picked colour', async () => {
    w = mount(RuntimeGroupNameModal, { props: { visible: true, mode: 'create' }, attachTo: document.body });
    await w.vm.$nextTick();
    expect(document.body.querySelector('.group-color-picker')).not.toBeNull();

    const input = document.body.querySelector('input') as HTMLInputElement;
    input.value = 'Auth sweep';
    input.dispatchEvent(new Event('input'));
    const vm = w.vm as unknown as { handleButton: (b: string) => boolean };
    vm.handleButton('DPadRight');
    vm.handleButton('A');

    expect(w.emitted('submit')?.[0]).toEqual(['Auth sweep', RUNTIME_GROUP_COLORS[1]]);
  });
});
