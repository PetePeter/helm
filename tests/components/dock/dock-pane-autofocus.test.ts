/**
 * A pane jump moves the dock's focus; a pane whose point is typing (the draft)
 * must also get the caret, or Ctrl+G lands you next to the box, not in it.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { defineComponent, h } from 'vue';
import { flushPromises, mount } from '@vue/test-utils';
import DockPane from '../../../renderer/components/dock/DockPane.vue';

const Typing = defineComponent({ render: () => h('div', [h('button', 'x'), h('textarea', { 'data-autofocus': '' })]) });
const Plain = defineComponent({ render: () => h('button', 'x') });

function mountPane(component = Typing) {
  return mount(DockPane, {
    props: { paneId: 'draft', active: true, focused: false, component },
    attachTo: document.body,
  });
}

describe('DockPane autofocus', () => {
  it('puts the caret in the marked field when the pane gains dock focus', async () => {
    const w = mountPane();
    await w.setProps({ focused: true });
    await flushPromises();
    expect(document.activeElement).toBe(w.find('textarea').element);
    w.unmount();
  });

  it('leaves focus alone when it is already inside the pane', async () => {
    const w = mountPane();
    (w.find('button').element as HTMLButtonElement).focus();
    await w.setProps({ focused: true });
    await flushPromises();
    expect(document.activeElement).toBe(w.find('button').element);
    w.unmount();
  });

  it('does not grab focus for panes without a marked field', async () => {
    const outside = document.body.appendChild(document.createElement('input'));
    outside.focus();
    const w = mountPane(Plain);
    await w.setProps({ focused: true });
    await flushPromises();
    expect(document.activeElement).toBe(outside);
    w.unmount();
    outside.remove();
  });
});
