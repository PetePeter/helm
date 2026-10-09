import { describe, expect, it } from 'vitest';
import {
  DOCK_PANES,
  dockPaneRegistry,
  type DockPaneDescriptor,
} from '../renderer/dock-types.js';
import {
  createDefaultLayout,
  ensurePane,
  listPanes,
  pruneUnregisteredPanes,
  validateLayout,
} from '../renderer/dock-layout.js';
import { afterEach } from 'vitest';

const dynamicPane: DockPaneDescriptor = {
  id: 'sessions:peer-a',
  kind: 'tool',
  title: 'Sessions - Box',
  icon: '🗂',
  closable: true,
  home: 'left',
  dynamic: true,
};

describe('dynamic dock registry and layout slots', () => {
  afterEach(() => dockPaneRegistry.unregister(dynamicPane.id));

  it('registers and updates runtime descriptors without changing static panes', () => {
    const staticIds = DOCK_PANES.map(pane => pane.id);
    dockPaneRegistry.register(dynamicPane);
    expect(dockPaneRegistry.get(dynamicPane.id)).toMatchObject(dynamicPane);
    expect(dockPaneRegistry.list('main').map(pane => pane.id)).toContain(dynamicPane.id);

    dockPaneRegistry.register({ ...dynamicPane, title: 'Sessions - Laptop' });
    expect(dockPaneRegistry.get(dynamicPane.id)?.title).toBe('Sessions - Laptop');
    dockPaneRegistry.unregister(dynamicPane.id);
    expect(dockPaneRegistry.get(dynamicPane.id)).toBeUndefined();
    expect(dockPaneRegistry.list('main').map(pane => pane.id)).toEqual(staticIds);
  });

  it('opens a newly registered pane at its home and avoids reopening a closed pane', () => {
    dockPaneRegistry.register(dynamicPane);
    const first = ensurePane(createDefaultLayout(), dynamicPane.id);
    expect(listPanes(first.root)).toContain(dynamicPane.id);

    const closed = { ...first, root: { type: 'empty' as const }, closed: [...first.closed, dynamicPane.id] };
    const restored = ensurePane(closed, dynamicPane.id);
    expect(restored.closed).toContain(dynamicPane.id);
    expect(listPanes(restored.root)).not.toContain(dynamicPane.id);
  });

  it('keeps an unresolved saved slot until registry reconciliation drops it', () => {
    const layout = createDefaultLayout();
    const root = structuredClone(layout.root);
    const visit = (node: typeof root): void => {
      if (node.type === 'group') {
        if (node.tabs.includes('sessions')) node.tabs.push('sessions:unpaired-peer');
      } else if (node.type === 'dock') visit(node.child);
      else if (node.type === 'split') node.children.forEach(visit);
    };
    visit(root);
    const unresolved = { ...layout, root };

    expect(listPanes(unresolved.root)).toContain('sessions:unpaired-peer');
    expect(listPanes(validateLayout(unresolved).root)).toContain('sessions:unpaired-peer');
    const reconciled = pruneUnregisteredPanes(unresolved, new Set(DOCK_PANES.map(pane => pane.id)));
    expect(listPanes(reconciled.root)).not.toContain('sessions:unpaired-peer');
  });
});
