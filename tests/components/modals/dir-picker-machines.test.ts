/**
 * DirPickerModal machine tabs — spawn on this PC or a fleet peer. The modal only
 * shows tabs and emits the chosen machine; the host loads that machine's dirs.
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mount, type VueWrapper } from '@vue/test-utils';
import DirPickerModal from '../../../renderer/components/modals/DirPickerModal.vue';

const machines = [{ id: '', label: 'This PC' }, { id: 'p1', label: 'Box' }];
const items = [{ name: 'proj', path: 'C:\\proj' }];

let w: VueWrapper<any> | null = null;
afterEach(() => { w?.unmount(); w = null; document.body.innerHTML = ''; });

function open(props: Record<string, unknown> = {}) {
  w = mount(DirPickerModal, { props: { visible: true, cliType: 'claude-code', items, machines, machineId: '', ...props }, attachTo: document.body });
  return w;
}

describe('DirPickerModal — machine tabs', () => {
  it('shows no tabs when this PC is the only machine', () => {
    open({ machines: [{ id: '', label: 'This PC' }] });
    expect(document.querySelectorAll('.dir-picker-machine')).toHaveLength(0);
  });

  it('marks the current machine and emits another on click', async () => {
    const wrapper = open();
    const tabs = document.querySelectorAll<HTMLElement>('.dir-picker-machine');
    expect([...tabs].map((t) => t.textContent?.trim())).toEqual(['This PC', 'Box']);
    expect(tabs[0].classList.contains('dir-picker-machine--active')).toBe(true);
    tabs[1].click();
    expect(wrapper.emitted('machine')).toEqual([['p1']]);
  });

  it('bumpers and left/right cycle machines, wrapping', () => {
    const wrapper = open();
    wrapper.vm.handleButton('RightBumper');
    wrapper.vm.handleButton('DPadLeft');
    expect(wrapper.emitted('machine')).toEqual([['p1'], ['p1']]);
  });

  it('selecting a dir emits the path (the host knows the machine)', () => {
    const wrapper = open({ machineId: 'p1' });
    wrapper.vm.handleButton('A');
    expect(wrapper.emitted('select')).toEqual([['C:\\proj']]);
  });

  it('shows loading and error states for a remote machine', async () => {
    open({ machineId: 'p1', items: [], loading: true });
    expect(document.body.textContent).toContain('Loading');
    await w!.setProps({ loading: false, error: 'No live link' });
    expect(document.body.textContent).toContain('No live link');
  });
});
