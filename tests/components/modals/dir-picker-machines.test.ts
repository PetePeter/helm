/**
 * The directory picker receives an already selected machine. Machine selection
 * belongs to Quick Spawn, before choosing a tool.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import DirPickerModal from '../../../renderer/components/modals/DirPickerModal.vue';

const items = [{ name: 'proj', path: 'C:\\proj' }];

let w: VueWrapper<any> | null = null;
afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; });

function open(props: Record<string, unknown> = {}) {
  w = mount(DirPickerModal, { props: { visible: true, cliType: 'claude-code', items, ...props }, attachTo: document.body });
  return w;
}

describe('DirPickerModal — selected machine folders', () => {
  it('shows directories without offering a second machine choice', () => {
    const wrapper = open();
    expect(document.querySelectorAll('[role="tab"]')).toHaveLength(0);
    expect(document.body.textContent).toContain('C:\\proj');
  });

  it('selecting a dir emits the path for its already selected machine', () => {
    const wrapper = open({ machineId: 'p1' });
    wrapper.vm.handleButton('A');
    expect(wrapper.emitted('select')).toEqual([['C:\\proj', 'p1']]);
  });

  it('shows loading and error states for a remote machine', async () => {
    open({ machineId: 'p1', items: [], loading: true });
    expect(document.body.textContent).toContain('Loading');
    await w!.setProps({ loading: false, error: 'No live link' });
    expect(document.body.textContent).toContain('No live link');
  });
});
