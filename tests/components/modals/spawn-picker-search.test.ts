/**
 * Search behavior in the real desktop spawn picker modals.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPinia, disposePinia, setActivePinia } from 'pinia';
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils';
import { nextTick } from 'vue';
import QuickSpawnModal from '../../../renderer/components/modals/QuickSpawnModal.vue';
import DirPickerModal from '../../../renderer/components/modals/DirPickerModal.vue';
import { useModalKeyboardBridge } from '../../../renderer/composables/useModalKeyboardBridge.js';
import { useModalStack } from '../../../renderer/composables/useModalStack.js';
import { useEscProtection } from '../../../renderer/composables/useEscProtection.js';

const directories = [
  { name: 'src', path: 'C:/repos/Alpha/src', projectId: 'alpha', projectName: 'Alpha' },
  { name: 'tests', path: 'C:/repos/Alpha/tests', projectId: 'alpha', projectName: 'Alpha' },
  { name: 'workspace', path: 'C:/repos/Beta/workspace', projectId: 'beta', projectName: 'Beta' },
  { name: 'packages', path: 'C:/repos/Beta/packages', projectId: 'beta', projectName: 'Beta' },
];
const longDirectories = Array.from({ length: 16 }, (_, projectIndex) =>
  Array.from({ length: 16 }, (_, dirIndex) => ({
    name: `dir-${dirIndex}`,
    path: `C:/repos/project-${projectIndex}/dir-${dirIndex}`,
    projectId: `project-${projectIndex}`,
    projectName: `Project ${projectIndex}`,
  })),
).flat();

let pinia: ReturnType<typeof createPinia>;
const wrappers: VueWrapper<any>[] = [];
const scrollCalls: Array<{ target: HTMLElement; options?: ScrollIntoViewOptions }> = [];
let scrollIntoViewDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  scrollCalls.length = 0;
  scrollIntoViewDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value: function (this: HTMLElement, options?: ScrollIntoViewOptions) {
      scrollCalls.push({ target: this, options });
    },
  });
  pinia = createPinia();
  setActivePinia(pinia);
  useModalStack().clear();
  useEscProtection().dismissProtection();
});

afterEach(() => {
  wrappers.splice(0).forEach(wrapper => wrapper.unmount());
  useModalStack().clear();
  useEscProtection().dismissProtection();
  disposePinia(pinia);
  document.body.innerHTML = '';
  if (scrollIntoViewDescriptor) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoViewDescriptor);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

function mountQuickSpawn(cliTypes = ['claude-code', 'codex', 'gemini']) {
  const wrapper = mount(QuickSpawnModal, {
    props: { visible: true, cliTypes },
    global: { plugins: [pinia] },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

function mountDirPicker(items = directories) {
  const wrapper = mount(DirPickerModal, {
    props: { visible: true, cliType: 'claude-code', items },
    attachTo: document.body,
  });
  wrappers.push(wrapper);
  return wrapper;
}

function getSearchInput(label: string): HTMLInputElement {
  const input = document.body.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!input) throw new Error(`Missing search input: ${label}`);
  return input;
}

async function setSearchValue(input: HTMLInputElement, value: string): Promise<void> {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await nextTick();
}

describe('spawn picker search', () => {
  it('filters CLI names case-insensitively and selects the visible result', async () => {
    const wrapper = mountQuickSpawn();
    await flushPromises();

    const search = getSearchInput('Search CLI types');
    expect(document.activeElement).toBe(search);
    await setSearchValue(search, 'CoDeX');

    const options = document.body.querySelectorAll('[role="option"]');
    expect(options).toHaveLength(1);
    expect(options[0].id).toBe('quick-spawn-option-0');
    (wrapper.vm as any).handleButton('A');

    expect(wrapper.emitted('select')).toEqual([['codex']]);
  });

  it('keeps keyboard and gamepad navigation on filtered CLI results while search stays focused', async () => {
    const wrapper = mountQuickSpawn();
    await flushPromises();
    const search = getSearchInput('Search CLI types');
    await setSearchValue(search, '');

    const keyboardEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
    expect(useModalKeyboardBridge().handler(keyboardEvent)).toBe(true);
    await nextTick();
    expect(document.body.querySelector('.dir-picker-item--focused .dir-picker-item__name')?.textContent).toBe('codex');
    expect(document.activeElement).toBe(search);

    (wrapper.vm as any).handleButton('DPadDown');
    await nextTick();
    expect(document.body.querySelector('.dir-picker-item--focused .dir-picker-item__name')?.textContent).toBe('gemini');
    expect(document.activeElement).toBe(search);
  });

  it('shows an empty state when no CLI type matches', async () => {
    mountQuickSpawn();
    await setSearchValue(getSearchInput('Search CLI types'), 'missing');

    expect(document.body.querySelectorAll('.quick-spawn-overlay [role="option"]')).toHaveLength(0);
    expect(document.body.textContent).toContain('No matching CLI types');
  });

  it('filters projects and directories by case-insensitive names and paths', async () => {
    const wrapper = mountDirPicker();
    await flushPromises();

    const search = getSearchInput('Search projects and directories');
    expect(document.activeElement).toBe(search);
    await setSearchValue(search, 'bEtA');

    expect(document.body.querySelectorAll('.dir-picker-project')).toHaveLength(1);
    expect(document.body.querySelector('.dir-picker-project__name')?.textContent).toBe('Beta');
    expect(document.body.querySelectorAll('.dir-picker-item')).toHaveLength(2);

    await setSearchValue(search, 'C:/REPOS/BETA/workspace');
    expect(document.body.querySelectorAll('.dir-picker-project')).toHaveLength(1);
    expect(document.body.querySelectorAll('.dir-picker-item')).toHaveLength(1);
    expect(document.body.querySelector('.dir-picker-item__name')?.textContent).toContain('workspace');

    (wrapper.vm as any).handleButton('A');
    (wrapper.vm as any).handleButton('A');
    expect(wrapper.emitted('select')).toEqual([['C:/repos/Beta/workspace', '']]);
  });

  it('navigates only visible directories with keyboard and gamepad while search stays focused', async () => {
    const wrapper = mountDirPicker();
    await flushPromises();
    const search = getSearchInput('Search projects and directories');
    await setSearchValue(search, 'bEtA');

    (wrapper.vm as any).handleButton('A');
    const keyboardEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true });
    expect(useModalKeyboardBridge().handler(keyboardEvent)).toBe(true);
    await nextTick();
    expect(document.body.querySelector('.dir-picker-item--focused .dir-picker-item__name')?.textContent).toContain('packages');
    expect(document.activeElement).toBe(search);

    (wrapper.vm as any).handleButton('DPadUp');
    await nextTick();
    expect(document.body.querySelector('.dir-picker-item--focused .dir-picker-item__name')?.textContent).toContain('workspace');
    expect(document.activeElement).toBe(search);

    search.setSelectionRange(0, 0);
    expect(useModalKeyboardBridge().handler(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))).toBe(true);
    await nextTick();
    expect(document.body.querySelector('.dir-picker-project--active .dir-picker-project__name')?.textContent).toBe('Beta');
    expect(document.activeElement).toBe(search);
  });

  it('shows an empty state when no project or directory matches', async () => {
    mountDirPicker();
    await setSearchValue(getSearchInput('Search projects and directories'), 'missing');

    expect(document.body.querySelectorAll('.dir-picker-project')).toHaveLength(0);
    expect(document.body.querySelectorAll('.dir-picker-item')).toHaveLength(0);
    expect(document.body.textContent).toContain('No matching projects or directories');
  });

  it('scrolls the active CLI, project, and directory rows into view', async () => {
    const cliTypes = Array.from({ length: 16 }, (_, index) => `cli-${index}`);
    const quickSpawn = mountQuickSpawn(cliTypes);
    await flushPromises();
    const quickSearch = getSearchInput('Search CLI types');

    for (let index = 0; index < 12; index++) {
      (quickSpawn.vm as any).handleButton('DPadDown');
      await nextTick();
    }
    expect(scrollCalls.at(-1)).toEqual({
      target: document.body.querySelector<HTMLElement>('#quick-spawn-option-12'),
      options: { block: 'nearest' },
    });
    expect(document.activeElement).toBe(quickSearch);

    quickSpawn.unmount();
    wrappers.splice(wrappers.indexOf(quickSpawn), 1);
    useModalStack().clear();

    const dirPicker = mountDirPicker(longDirectories);
    await flushPromises();
    const dirSearch = getSearchInput('Search projects and directories');
    for (let index = 0; index < 12; index++) {
      (dirPicker.vm as any).handleButton('DPadDown');
      await nextTick();
    }
    expect(scrollCalls.at(-1)).toEqual({
      target: document.body.querySelector<HTMLElement>('#dir-picker-project-12'),
      options: { block: 'nearest' },
    });

    (dirPicker.vm as any).handleButton('A');
    await nextTick();
    for (let index = 0; index < 12; index++) {
      (dirPicker.vm as any).handleButton('DPadDown');
      await nextTick();
    }
    expect(scrollCalls.at(-1)).toEqual({
      target: document.body.querySelector<HTMLElement>('#dir-picker-option-12'),
      options: { block: 'nearest' },
    });
    expect(document.activeElement).toBe(dirSearch);
  });
});
