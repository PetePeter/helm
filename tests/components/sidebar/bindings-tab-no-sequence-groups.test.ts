/**
 * BindingsTab.vue — PT-7 teardown regression: the per-CLI "Sequence Groups"
 * section was removed. This guards against it being reintroduced.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import BindingsTab from '../../../renderer/components/sidebar/BindingsTab.vue';

function mountTab() {
  return mount(BindingsTab, {
    props: {
      bindings: [],
      profiles: [{ id: 'p1', name: 'Default' }],
      profileId: 'p1',
      addableButtons: [],
      sortField: 'button',
      sortDirection: 'asc' as const,
    },
  });
}

describe('BindingsTab.vue — no Sequence Groups UI (PT-7)', () => {
  it('does not render the Sequence Groups section or Add Group button', () => {
    const w = mountTab();
    expect(w.text()).not.toContain('Sequence Groups');
    expect(w.text()).not.toContain('Add Group');
    w.unmount();
  });
});
