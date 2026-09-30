/**
 * Plan canvas viewport: the view keeps a fixed zoom (screen px per canvas
 * unit). Resizing the pane shows more or less canvas — it never rescales the
 * plan. Real helpers, no DOM.
 */
import { describe, it, expect } from 'vitest';
import { fitViewBox, resizeViewBox, viewBoxFromSaved, savedFromViewBox } from '../renderer/plans/plan-viewport.js';

const zoomOf = (vb: { w: number }, pxW: number) => pxW / vb.w;

describe('plan viewport', () => {
  it('resizing the pane keeps the zoom and the top-left corner', () => {
    const vb = { x: 100, y: 50, w: 400, h: 300 }; // 800x600 px pane → zoom 2
    const next = resizeViewBox(vb, { w: 800, h: 600 }, { w: 1200, h: 900 });
    expect(zoomOf(next, 1200)).toBe(2);
    expect(next).toMatchObject({ x: 100, y: 50 });
  });

  it('a wider pane shows more canvas, a narrower one less', () => {
    const vb = { x: 0, y: 0, w: 400, h: 300 };
    expect(resizeViewBox(vb, { w: 800, h: 600 }, { w: 1600, h: 600 }).w).toBe(800);
    expect(resizeViewBox(vb, { w: 800, h: 600 }, { w: 400, h: 600 }).w).toBe(200);
  });

  it('ignores a pane with no size yet (hidden) instead of collapsing the view', () => {
    const vb = { x: 0, y: 0, w: 400, h: 300 };
    expect(resizeViewBox(vb, { w: 0, h: 0 }, { w: 800, h: 600 })).toEqual(vb);
    expect(resizeViewBox(vb, { w: 800, h: 600 }, { w: 0, h: 0 })).toEqual(vb);
  });

  it('first open fits the whole plan at one uniform zoom', () => {
    const vb = fitViewBox({ width: 1600, height: 600 }, { w: 800, h: 600 });
    expect(zoomOf(vb, 800)).toBeCloseTo(0.5);
    expect(vb.h * 0.5).toBeCloseTo(600);
    expect(vb).toMatchObject({ x: 0, y: 0 });
  });

  it('a saved view restores the same zoom and position in a differently sized pane', () => {
    const saved = savedFromViewBox({ x: 120, y: 40, w: 400, h: 300 }, { w: 800, h: 600 });
    const restored = viewBoxFromSaved(saved, { w: 1000, h: 500 });
    expect(zoomOf(restored, 1000)).toBe(2);
    expect(restored).toMatchObject({ x: 120, y: 40, w: 500, h: 250 });
  });
});
