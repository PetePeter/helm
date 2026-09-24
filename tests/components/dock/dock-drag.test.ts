/**
 * Dock drag/drop interaction: the click-vs-drag threshold, every preview zone,
 * cancellation, outer-edge docking, tab reorder, and the keyboard equivalents.
 *
 * Real components with a stubbed pane implementation. jsdom reports zero-sized
 * boxes, so `getBoundingClientRect` is faked per element — the geometry under
 * test is the rule module's, not the browser's.
 *
 * @vitest-environment jsdom
 */
import { defineComponent, h, nextTick } from 'vue';
import { mount, type VueWrapper } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import DockWorkspace from '../../../renderer/components/dock/DockWorkspace.vue';
import { DRAG_THRESHOLD_PX } from '../../../renderer/dock-drag';
import type { DockWorkspaceLayout } from '../../../renderer/dock-types';
import {
  DOCK_LAYOUT_VERSION,
  PANE_ARTIFACTS,
  PANE_MESS,
  PANE_TERMINAL,
} from '../../../renderer/dock-types';

const PaneStub = defineComponent({
  name: 'PaneStub',
  props: { paneId: { type: String, required: true } },
  setup: (props) => () => h('div', { 'data-pane-content': props.paneId }, props.paneId),
});

/** Workspace 1000x600; left group 0-600 holding Terminal+Overview, right group 600-1000. */
const RECTS: Record<string, { x: number; y: number; width: number; height: number }> = {
  workspace: { x: 0, y: 0, width: 1000, height: 600 },
  [`group:${PANE_TERMINAL}`]: { x: 0, y: 0, width: 600, height: 600 },
  [`group:${PANE_ARTIFACTS}`]: { x: 600, y: 0, width: 400, height: 600 },
  [`strip:${PANE_TERMINAL}`]: { x: 0, y: 0, width: 600, height: 30 },
  [`strip:${PANE_ARTIFACTS}`]: { x: 600, y: 0, width: 400, height: 30 },
  [`tab:${PANE_TERMINAL}`]: { x: 0, y: 0, width: 100, height: 30 },
  [`tab:${PANE_MESS}`]: { x: 100, y: 0, width: 100, height: 30 },
  [`tab:${PANE_ARTIFACTS}`]: { x: 600, y: 0, width: 100, height: 30 },
};

function keyFor(element: HTMLElement): string | null {
  if (element.dataset.dockWorkspace !== undefined) return 'workspace';
  if (element.dataset.dockTabId) return `tab:${element.dataset.dockTabId}`;
  if (element.dataset.dockTabs !== undefined) {
    const owner = element.closest<HTMLElement>('[data-dock-group-active]');
    return owner ? `strip:${owner.dataset.dockGroupActive}` : null;
  }
  if (element.dataset.dockGroupActive) return `group:${element.dataset.dockGroupActive}`;
  return null;
}

let originalRect: typeof HTMLElement.prototype.getBoundingClientRect;

beforeEach(() => {
  originalRect = HTMLElement.prototype.getBoundingClientRect;
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const rect = RECTS[keyFor(this) ?? ''] ?? { x: 0, y: 0, width: 0, height: 0 };
    return {
      ...rect,
      left: rect.x,
      top: rect.y,
      right: rect.x + rect.width,
      bottom: rect.y + rect.height,
      toJSON: () => rect,
    } as DOMRect;
  };
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = originalRect;
  document.body.classList.remove('dock-dragging');
});

function layout(): DockWorkspaceLayout {
  return {
    version: DOCK_LAYOUT_VERSION,
    root: {
      type: 'split',
      direction: 'horizontal',
      sizes: [0.6, 0.4],
      children: [
        { type: 'group', tabs: [PANE_TERMINAL, PANE_MESS], activeTab: PANE_TERMINAL },
        { type: 'group', tabs: [PANE_ARTIFACTS], activeTab: PANE_ARTIFACTS },
      ],
    },
    closed: [],
  };
}

function mountWorkspace(): VueWrapper {
  return mount(DockWorkspace, {
    attachTo: document.body,
    props: {
      layout: layout(),
      focusedPaneId: PANE_TERMINAL,
      paneComponents: {
        [PANE_TERMINAL]: PaneStub,
        [PANE_MESS]: PaneStub,
        [PANE_ARTIFACTS]: PaneStub,
      },
    },
  });
}

function pointer(type: string, x: number, y: number): void {
  const event = new MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  window.dispatchEvent(event);
}

async function press(wrapper: VueWrapper, paneId: string, x: number, y: number): Promise<void> {
  // Dispatched directly: test-utils' `trigger` cannot set the read-only `button`.
  const tab = wrapper.find(`[role="tab"][aria-controls="dock-pane-${paneId}"]`).element;
  const event = new MouseEvent('pointerdown', { button: 0, clientX: x, clientY: y, bubbles: true });
  Object.defineProperty(event, 'pointerId', { value: 7 });
  tab.dispatchEvent(event);
  await nextTick();
}

/** jsdom implements no pointer capture; record the calls the composable makes. */
function stubPointerCapture(): { captured: number[]; released: number[]; restore: () => void } {
  const captured: number[] = [];
  const released: number[] = [];
  const held = new Set<number>();
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  const original = {
    set: proto.setPointerCapture,
    release: proto.releasePointerCapture,
    has: proto.hasPointerCapture,
  };
  proto.setPointerCapture = function (id: number) { captured.push(id); held.add(id); };
  proto.releasePointerCapture = function (id: number) { released.push(id); held.delete(id); };
  proto.hasPointerCapture = function (id: number) { return held.has(id); };
  return {
    captured,
    released,
    restore: () => {
      const put = (key: string, value: unknown) => {
        if (value === undefined) delete proto[key];
        else proto[key] = value;
      };
      put('setPointerCapture', original.set);
      put('releasePointerCapture', original.release);
      put('hasPointerCapture', original.has);
    },
  };
}

async function dragTo(x: number, y: number): Promise<void> {
  pointer('pointermove', x, y);
  await nextTick();
}

describe('dock drag interaction', () => {
  it('keeps a press below the threshold a click, mutating nothing', async () => {
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    await dragTo(620 + DRAG_THRESHOLD_PX - 1, 10);

    expect(wrapper.find('[data-dock-preview]').exists()).toBe(false);
    pointer('pointerup', 620 + DRAG_THRESHOLD_PX - 1, 10);
    await nextTick();
    expect(wrapper.emitted('move-pane')).toBeUndefined();
    expect(wrapper.emitted('reorder-tab')).toBeUndefined();
    expect(wrapper.emitted('dock-pane-edge')).toBeUndefined();
    wrapper.unmount();
  });

  it.each([
    ['center', 300, 300, { paneId: PANE_TERMINAL, zone: 'center' }],
    // Clear of the workspace border, which would otherwise be an outer-edge dock.
    ['left', 40, 300, { paneId: PANE_TERMINAL, zone: 'left' }],
    ['right', 560, 300, { paneId: PANE_TERMINAL, zone: 'right' }],
    ['top', 300, 100, { paneId: PANE_TERMINAL, zone: 'top' }],
    ['bottom', 300, 560, { paneId: PANE_TERMINAL, zone: 'bottom' }],
  ])('commits a %s drop on the pane under the pointer', async (_zone, x, y, target) => {
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    await dragTo(x, y);

    expect(wrapper.find('[data-dock-preview]').exists()).toBe(true);
    pointer('pointerup', x, y);
    await nextTick();
    expect(wrapper.emitted('move-pane')?.at(-1)).toEqual([PANE_ARTIFACTS, target]);
    wrapper.unmount();
  });

  it('previews the same rectangle the split will occupy', async () => {
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    await dragTo(560, 300);

    const style = wrapper.find('[data-dock-preview]').attributes('style') ?? '';
    // Right half of the 0-600 group, in workspace-local coordinates.
    expect(style).toContain('left: 300px');
    expect(style).toContain('width: 300px');
    expect(style).toContain('height: 600px');
    wrapper.unmount();
  });

  it('docks to the workspace edge the pointer hugs', async () => {
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    await dragTo(300, 596);
    expect(wrapper.find('[data-dock-preview]').attributes('data-dock-preview-kind')).toBe('edge');

    pointer('pointerup', 300, 596);
    await nextTick();
    expect(wrapper.emitted('dock-pane-edge')?.at(-1)).toEqual([PANE_ARTIFACTS, 'bottom']);
    wrapper.unmount();
  });

  it('reorders a tab dragged along its own strip', async () => {
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_TERMINAL, 20, 10);
    await dragTo(180, 10);
    expect(wrapper.find('[data-dock-preview]').attributes('data-dock-preview-kind')).toBe('reorder');

    pointer('pointerup', 180, 10);
    await nextTick();
    expect(wrapper.emitted('reorder-tab')?.at(-1)).toEqual([PANE_TERMINAL, 1]);
    wrapper.unmount();
  });

  it('does not reorder a tab dropped back into its own slot', async () => {
    const wrapper = mountWorkspace();
    // Terminal is already first; dragging it across its own tab changes nothing.
    await press(wrapper, PANE_TERMINAL, 20, 10);
    await dragTo(80, 10);

    expect(wrapper.find('[data-dock-preview]').exists()).toBe(false);
    pointer('pointerup', 80, 10);
    await nextTick();
    expect(wrapper.emitted('reorder-tab')).toBeUndefined();
    wrapper.unmount();
  });

  it('suppresses the preview for a drop the model rejects', async () => {
    const wrapper = mountWorkspace();
    // Overview is already tabbed with Terminal, so a centre drop is a no-op.
    await press(wrapper, PANE_MESS, 120, 10);
    await dragTo(300, 300);

    expect(wrapper.find('[data-dock-preview]').exists()).toBe(false);
    pointer('pointerup', 300, 300);
    await nextTick();
    expect(wrapper.emitted('move-pane')).toBeUndefined();
    wrapper.unmount();
  });

  it('leaves the layout untouched when the drop lands outside every surface', async () => {
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    await dragTo(5000, 5000);

    expect(wrapper.find('[data-dock-preview]').exists()).toBe(false);
    pointer('pointerup', 5000, 5000);
    await nextTick();
    expect(wrapper.emitted('move-pane')).toBeUndefined();
    wrapper.unmount();
  });

  it('cancels an in-flight drag on Escape', async () => {
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    await dragTo(300, 300);
    expect(document.body.classList.contains('dock-dragging')).toBe(true);

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    await nextTick();
    expect(document.body.classList.contains('dock-dragging')).toBe(false);
    expect(wrapper.find('[data-dock-drag-ghost]').exists()).toBe(false);

    pointer('pointerup', 300, 300);
    await nextTick();
    expect(wrapper.emitted('move-pane')).toBeUndefined();
    wrapper.unmount();
  });

  it('captures the pointer on the initiating tab and releases it on drop', async () => {
    const capture = stubPointerCapture();
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    expect(capture.captured).toEqual([7]);

    await dragTo(300, 300);
    pointer('pointerup', 300, 300);
    await nextTick();
    // Released before the move is emitted, so the tab may be re-rendered freely.
    expect(capture.released).toEqual([7]);
    expect(wrapper.emitted('move-pane')?.at(-1)).toEqual([PANE_ARTIFACTS, { paneId: PANE_TERMINAL, zone: 'center' }]);
    capture.restore();
    wrapper.unmount();
  });

  it.each([
    ['pointercancel', () => pointer('pointercancel', 300, 300)],
    ['window blur', () => window.dispatchEvent(new Event('blur'))],
    ['unmount', () => undefined],
  ])('leaves no stale capture, ghost or body class after %s', async (_label, interrupt) => {
    const capture = stubPointerCapture();
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    await dragTo(300, 300);
    expect(document.body.classList.contains('dock-dragging')).toBe(true);

    interrupt();
    await nextTick();
    if (_label === 'unmount') wrapper.unmount();
    await nextTick();

    expect(capture.released).toEqual([7]);
    expect(document.body.classList.contains('dock-dragging')).toBe(false);
    if (_label !== 'unmount') expect(wrapper.find('[data-dock-drag-ghost]').exists()).toBe(false);

    // The listeners are gone too, so a late pointerup cannot resurrect the drop.
    pointer('pointerup', 300, 300);
    await nextTick();
    expect(wrapper.emitted('move-pane')).toBeUndefined();
    capture.restore();
    if (_label !== 'unmount') wrapper.unmount();
  });

  it('shows a ghost labelled with the dragged pane while dragging', async () => {
    const wrapper = mountWorkspace();
    await press(wrapper, PANE_ARTIFACTS, 620, 10);
    await dragTo(300, 300);
    expect(wrapper.find('[data-dock-drag-ghost]').text()).toBe('Artifacts');
    wrapper.unmount();
  });

  it('offers keyboard equivalents for edge docking and tab reorder', async () => {
    const wrapper = mountWorkspace();
    const tab = wrapper.find(`[role="tab"][aria-controls="dock-pane-${PANE_TERMINAL}"]`);

    await tab.trigger('keydown', { key: 'ArrowLeft', ctrlKey: true, shiftKey: true });
    expect(wrapper.emitted('dock-pane-edge')?.at(-1)).toEqual([PANE_TERMINAL, 'left']);

    await tab.trigger('keydown', { key: 'PageDown', ctrlKey: true, shiftKey: true });
    expect(wrapper.emitted('reorder-tab')?.at(-1)).toEqual([PANE_TERMINAL, 1]);

    // Without the modifiers the same arrow still navigates tabs.
    await tab.trigger('keydown', { key: 'ArrowRight' });
    expect(wrapper.emitted('activate-pane')?.at(-1)).toEqual([PANE_MESS]);
    wrapper.unmount();
  });
});
