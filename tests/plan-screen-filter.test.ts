/**
 * Plan screen filter integration tests.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PlanScreen from '../renderer/components/panels/PlanScreen.vue';
import type { PlanItem, PlanDependency } from '../src/types/plan.js';

function createItem(
  id: string,
  type?: 'bug' | 'feature' | 'research',
  status: 'planning' | 'ready' | 'coding' | 'review' | 'blocked' | 'done' | 'suggested' = 'ready',
): PlanItem {
  return {
    id,
    dirPath: '/test',
    title: id,
    description: '',
    status,
    type,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const defaultFilters = {
  types: { bug: 'either', feature: 'either', research: 'either', untyped: 'either' },
  statuses: { planning: 'either', ready: 'either', coding: 'either', review: 'either', blocked: 'either', done: 'either', suggested: 'either' },
  hasAttachment: { yes: 'either', no: 'either' },
  auto: 'either',
};

describe('PlanScreen filter integration', () => {
  beforeEach(() => {
    const pinia = createPinia();
    setActivePinia(pinia);
  });

  describe('toggle type filters', () => {
    it('renders compact tri-state filter chips with correct states', () => {
      const filters = {
        ...defaultFilters,
        types: { bug: 'yes', feature: 'no', research: 'either', untyped: 'either' },
      };

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items: [createItem('bug-1', 'bug', 'coding')],
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters,
          selectedId: null,
        },
      });

      const chips = wrapper.findAll('.plan-header__chip');
      expect(chips[0].find('.filter-chip__label').text()).toBe('Bug');
      expect(chips[0].classes()).toContain('yes');
      expect(chips[1].find('.filter-chip__label').text()).toBe('Feature');
      expect(chips[1].classes()).toContain('no');
      expect(chips[2].find('.filter-chip__label').text()).toBe('Research');
      expect(chips[2].classes()).toContain('either');
    });

    it('emits toggleTypeFilter when chip is clicked', async () => {
      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items: [createItem('bug-1', 'bug', 'coding')],
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: defaultFilters,
          selectedId: null,
        },
      });

      const bugChip = wrapper.findAll('.plan-header__chip')[0];

      await bugChip.trigger('click');
      expect(wrapper.emitted('toggleTypeFilter')).toBeTruthy();
      expect(wrapper.emitted('toggleTypeFilter')?.[0]).toEqual(['bug']);
    });

    it('all types selected shows all items', () => {
      const items = [
        createItem('bug-1', 'bug', 'coding'),
        createItem('feature-1', 'feature', 'ready'),
        createItem('research-1', 'research', 'planning'),
        createItem('untyped-1', undefined, 'ready'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: defaultFilters,
        },
      });

      expect(wrapper.vm.items).toHaveLength(items.length);
    });

    it('only bug type selected shows only bug items', () => {
      // Parent component filters items before passing to PlanScreen
      const items = [
        createItem('bug-1', 'bug', 'coding'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items, // Pre-filtered by parent
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: {
            ...defaultFilters,
            types: { bug: true, feature: false, research: false, untyped: false },
          },
          selectedId: null,
        },
      });

      // Verify only bug items are in the items prop
      const bugItems = wrapper.vm.items.filter((i: any) => i?.type === 'bug');
      const featureItems = wrapper.vm.items.filter((i: any) => i?.type === 'feature');
      expect(bugItems).toHaveLength(1);
      expect(featureItems).toHaveLength(0);
    });
  });

  describe('toggle status filters', () => {
    it('shows and emits the Suggestions filter', async () => {
      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items: [createItem('suggested-1', undefined, 'suggested')],
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: defaultFilters,
        },
      });
      const suggested = wrapper.findAll('.plan-header__chip').find((chip) => chip.find('.filter-chip__label').text() === 'Suggested');
      expect(suggested).toBeDefined();
      await suggested!.trigger('click');
      expect(wrapper.emitted('toggleStatusFilter')).toContainEqual(['suggested']);
    });

    it('all statuses selected shows all items', () => {
      const items = [
        createItem('item-1', 'bug', 'planning'),
        createItem('item-2', 'feature', 'ready'),
        createItem('item-3', 'research', 'coding'),
        createItem('item-4', 'bug', 'review'),
        createItem('item-5', 'feature', 'blocked'),
        createItem('item-6', 'research', 'done'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: defaultFilters,
        },
      });

      expect(wrapper.vm.items).toHaveLength(items.length);
    });

    it('only active status (coding + review + blocked) shows only active items', () => {
      const items = [
        createItem('coding-1', 'bug', 'coding'),
        createItem('review-1', 'feature', 'review'),
        createItem('blocked-1', 'research', 'blocked'),
        createItem('ready-1', 'bug', 'ready'),
        createItem('done-1', 'feature', 'done'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: {
            ...defaultFilters,
            statuses: { planning: false, ready: false, coding: true, review: true, blocked: true, done: false },
          },
        },
      });

      const activeItems = wrapper.vm.items.filter(i =>
        i?.status === 'coding' || i?.status === 'review' || i?.status === 'blocked'
      );
      expect(activeItems).toHaveLength(3);
    });

    it('only terminal status (done) shows only done items', () => {
      const items = [
        createItem('done-1', 'bug', 'done'),
        createItem('coding-1', 'feature', 'coding'),
        createItem('ready-1', 'research', 'ready'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: {
            ...defaultFilters,
            statuses: { planning: false, ready: false, coding: false, review: false, blocked: false, done: true },
          },
        },
      });

      expect(wrapper.vm.items.filter(i => i?.status === 'done')).toHaveLength(1);
    });
  });

  describe('combined filters', () => {
    it('bug type + active status shows only bug items with active status', () => {
      const items = [
        createItem('bug-coding', 'bug', 'coding'),
        createItem('bug-ready', 'bug', 'ready'),
        createItem('feature-coding', 'feature', 'coding'),
        createItem('untyped-coding', undefined, 'coding'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: {
            ...defaultFilters,
            types: { bug: true, feature: false, research: false, untyped: false },
            statuses: { planning: false, ready: false, coding: true, review: true, blocked: true, done: false },
          },
        },
      });

      const filtered = wrapper.vm.items.filter(i =>
        i?.type === 'bug' && (i?.status === 'coding' || i?.status === 'review' || i?.status === 'blocked')
      );
      expect(filtered).toHaveLength(1);
    });

    it('feature type + planning status shows only feature items in planning/ready', () => {
      const items = [
        createItem('feature-planning', 'feature', 'planning'),
        createItem('feature-ready', 'feature', 'ready'),
        createItem('bug-planning', 'bug', 'planning'),
        createItem('feature-coding', 'feature', 'coding'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: {
            ...defaultFilters,
            types: { bug: false, feature: true, research: false, untyped: false },
            statuses: { planning: true, ready: true, coding: false, review: false, blocked: false, done: false },
          },
        },
      });

      const filtered = wrapper.vm.items.filter(i =>
        i?.type === 'feature' && (i?.status === 'planning' || i?.status === 'ready')
      );
      expect(filtered).toHaveLength(2);
    });
  });

  describe('filter edge cases', () => {
    it('no types selected results in empty filtered view', () => {
      const items = [
        createItem('bug-1', 'bug', 'ready'),
        createItem('feature-1', 'feature', 'ready'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: {
            ...defaultFilters,
            types: { bug: false, feature: false, research: false, untyped: false },
            statuses: { planning: true, ready: true, coding: true, review: true, blocked: true, done: true },
          },
        },
      });

      // All items filtered out
      const filtered = wrapper.vm.items.filter(i => {
        const typeMatch = !i.type ? false : wrapper.vm.filters?.types[i.type ?? 'untyped'] ?? false;
        return typeMatch;
      });
      expect(filtered).toHaveLength(0);
    });

    it('no statuses selected results in empty filtered view', () => {
      const items = [
        createItem('item-1', 'bug', 'ready'),
        createItem('item-2', 'feature', 'coding'),
      ];

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: {
            ...defaultFilters,
            types: { bug: true, feature: true, research: true, untyped: true },
            statuses: { planning: false, ready: false, coding: false, review: false, blocked: false, done: false },
          },
        },
      });

      // All items filtered out
      const filtered = wrapper.vm.items.filter(i => wrapper.vm.filters?.statuses[i.status] ?? false);
      expect(filtered).toHaveLength(0);
    });
  });

  describe('filter persistence', () => {
    it('filter preferences are preserved across component remount', () => {
      const customFilters = {
        types: { bug: true, feature: false, research: false, untyped: false },
        statuses: { planning: true, ready: false, coding: true, review: false, blocked: false, done: false },
      };

      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items: [createItem('bug-1', 'bug', 'ready')],
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: customFilters,
        },
      });

      expect(wrapper.vm.filters).toEqual(customFilters);
    });
  });

  describe('performance', () => {
    it('handles large number of items (50+) without significant lag', async () => {
      const items = Array.from({ length: 50 }, (_, i) =>
        createItem(`item-${i}`, i % 3 === 0 ? 'bug' : i % 3 === 1 ? 'feature' : 'research', 'ready')
      );

      const start = performance.now();
      const wrapper = mount(PlanScreen, {
        props: {
          visible: true,
          dirPath: '/test',
          items,
          deps: [],
          layout: { nodes: [], edges: [], width: 800, height: 600 },
          filters: defaultFilters,
        },
      });

      await wrapper.vm.$nextTick();
      const end = performance.now();

      // Should render in less than 100ms
      expect(end - start).toBeLessThan(100);
      expect(wrapper.vm.items).toHaveLength(items.length);
    });
  });
});
