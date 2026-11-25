/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest';
import { scrollWithin } from '../renderer/scroll-within.js';

/** jsdom has no layout: stub the two rects the helper reads. */
function setup(scrollTop: number, row: { top: number; bottom: number }) {
  const container = document.createElement('div');
  const el = document.createElement('div');
  container.appendChild(el);
  container.scrollTop = scrollTop;
  container.getBoundingClientRect = () => ({ top: 100, bottom: 300 } as DOMRect);
  el.getBoundingClientRect = () => ({ top: row.top, bottom: row.bottom } as DOMRect);
  return { container, el };
}

describe('scrollWithin', () => {
  it('scrolls up so a row above the viewport sits at the top edge', () => {
    const { container, el } = setup(500, { top: 60, bottom: 100 });
    scrollWithin(container, el);
    expect(container.scrollTop).toBe(460);
  });

  it('scrolls down so a row below the viewport sits at the bottom edge', () => {
    const { container, el } = setup(500, { top: 290, bottom: 340 });
    scrollWithin(container, el);
    expect(container.scrollTop).toBe(540);
  });

  it('leaves a fully visible row alone', () => {
    const { container, el } = setup(500, { top: 150, bottom: 200 });
    scrollWithin(container, el);
    expect(container.scrollTop).toBe(500);
  });

  it('never scrolls an ancestor of the container', () => {
    const outer = document.createElement('div');
    const { container, el } = setup(500, { top: 0, bottom: 40 });
    outer.appendChild(container);
    outer.scrollTop = 30;
    scrollWithin(container, el);
    expect(outer.scrollTop).toBe(30);
  });
});
