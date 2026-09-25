/**
 * TickerText component tests.
 *
 * jsdom does no layout, so overflow is injected via defineProperty on the
 * elements the component measures (host scrollWidth/clientWidth, run
 * offsetWidth). What is under test is the component's decision logic:
 * scroll only what is clipped, at a speed that scales with the text length.
 *
 * @vitest-environment jsdom
 */

import { nextTick } from 'vue';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mount } from '@vue/test-utils';
import TickerText from '../../../renderer/components/chips/TickerText.vue';

function stubMotion(reduced = false): void {
  (window as any).matchMedia = vi.fn().mockReturnValue({ matches: reduced });
}

function stubWidths(el: HTMLElement, scroll: number, client: number): void {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(el, 'clientWidth', { configurable: true, get: () => client });
}

function hostOf(wrapper: ReturnType<typeof mount>): HTMLElement {
  // The host is the component root itself, not a descendant.
  if (wrapper.element.classList.contains('ticker-text')) return wrapper.element as HTMLElement;
  return wrapper.element.querySelector('.ticker-text') as HTMLElement;
}

async function remeasure(wrapper: ReturnType<typeof mount>): Promise<void> {
  await (wrapper.vm as any).remeasure();
}

describe('TickerText.vue', () => {
  beforeEach(() => {
    stubMotion(false);
  });

  it('renders statically when the text fits (single copy, no animation)', async () => {
    const wrapper = mount(TickerText, { props: { text: 'short' } });
    stubWidths(hostOf(wrapper), 50, 100);
    await remeasure(wrapper);

    expect(hostOf(wrapper).classList.contains('ticker-text--scrolling')).toBe(false);
    // Static mode renders exactly one run; the duplicate only exists while scrolling.
    expect(hostOf(wrapper).querySelectorAll('.ticker-text__run')).toHaveLength(1);
  });

  it('scrolls when clipped, with a duration scaled to the text length', async () => {
    const wrapper = mount(TickerText, { props: { text: 'a very long plan title that cannot fit' } });
    const host = hostOf(wrapper);
    stubWidths(host, 400, 100);
    await remeasure(wrapper);

    expect(host.classList.contains('ticker-text--scrolling')).toBe(true);
    // Two copies (second aria-hidden) form the seamless loop.
    const runs = host.querySelectorAll('.ticker-text__run');
    expect(runs).toHaveLength(2);
    expect(runs[1].getAttribute('aria-hidden')).toBe('true');
    // 400px of overflow = two 200px loop units; each unit takes 200/30 = 6.67s
    const track = host.querySelector('.ticker-text__track') as HTMLElement;
    expect(track.style.animationDuration).toBe('6.67s');
  });

  it('re-measures when the text changes', async () => {
    const wrapper = mount(TickerText, { props: { text: 'short' } });
    const host = hostOf(wrapper);
    stubWidths(host, 50, 100);
    await remeasure(wrapper);
    expect(host.classList.contains('ticker-text--scrolling')).toBe(false);

    stubWidths(host, 400, 100);
    await wrapper.setProps({ text: 'now a much longer title' });
    // The watcher's remeasure resets to static, re-renders, then measures again.
    await nextTick();
    await nextTick();
    expect(host.classList.contains('ticker-text--scrolling')).toBe(true);
  });

  it('never animates under prefers-reduced-motion', async () => {
    stubMotion(true);
    const wrapper = mount(TickerText, { props: { text: 'long title' } });
    const host = hostOf(wrapper);
    stubWidths(host, 400, 100);
    await remeasure(wrapper);

    expect(host.classList.contains('ticker-text--scrolling')).toBe(false);
    expect(host.querySelectorAll('.ticker-text__run')).toHaveLength(1);
  });
});
