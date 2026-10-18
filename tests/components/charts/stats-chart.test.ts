/** @vitest-environment jsdom */
import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import StatsChart from '../../../renderer/components/charts/StatsChart.vue';
import type { ChartModel } from '../../../src/session/chart-model.js';

describe('StatsChart', () => {
  it('shows an empty state instead of creating an empty canvas chart', () => {
    const model: ChartModel = { columns: [], labels: [], series: [] };
    const wrapper = mount(StatsChart, { props: { model, kind: 'tokens' } });

    expect(wrapper.text()).toContain('No chart data');
    expect(wrapper.find('canvas').exists()).toBe(false);
    wrapper.unmount();
  });
});
