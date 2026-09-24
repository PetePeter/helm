/**
 * Pure drag geometry: thresholds, the five zones, outer edges, tab reorder
 * indices, and preview rectangles. No DOM, no Vue — the same rules the renderer
 * and the model agree on.
 */
import { describe, expect, it } from 'vitest';
import {
  DRAG_THRESHOLD_PX,
  edgeForPoint,
  exceedsDragThreshold,
  isNoOpReorder,
  previewRectForEdge,
  previewRectForTabIndex,
  previewRectForZone,
  resolveDrop,
  tabDropIndex,
  toLocalRect,
  zoneForPoint,
  type DockDragSurface,
} from '../renderer/dock-drag';
import {
  DOCK_MIN_TRACK_PX,
  DOCK_SPLITTER_PX,
  OUTER_EDGE_RATIO,
  PANE_ARTIFACTS,
  PANE_MESS,
  PANE_TERMINAL,
  splitTrackSize,
} from '../renderer/dock-types';

const PANE: { x: number; y: number; width: number; height: number } = { x: 100, y: 100, width: 400, height: 200 };

describe('drag threshold', () => {
  it('treats sub-threshold travel as a click and threshold travel as a drag', () => {
    const origin = { x: 10, y: 10 };
    expect(exceedsDragThreshold(origin, { x: 10, y: 10 })).toBe(false);
    expect(exceedsDragThreshold(origin, { x: 10 + DRAG_THRESHOLD_PX - 1, y: 10 })).toBe(false);
    expect(exceedsDragThreshold(origin, { x: 10 + DRAG_THRESHOLD_PX, y: 10 })).toBe(true);
    expect(exceedsDragThreshold(origin, { x: 10, y: 10 - DRAG_THRESHOLD_PX })).toBe(true);
  });
});

describe('zoneForPoint', () => {
  it('resolves all five zones and rejects points outside the pane', () => {
    expect(zoneForPoint(PANE, { x: 300, y: 200 })).toBe('center');
    expect(zoneForPoint(PANE, { x: 110, y: 200 })).toBe('left');
    expect(zoneForPoint(PANE, { x: 490, y: 200 })).toBe('right');
    expect(zoneForPoint(PANE, { x: 300, y: 110 })).toBe('top');
    expect(zoneForPoint(PANE, { x: 300, y: 290 })).toBe('bottom');
    expect(zoneForPoint(PANE, { x: 90, y: 200 })).toBeNull();
    expect(zoneForPoint(PANE, { x: 300, y: 400 })).toBeNull();
  });

  it('keeps the centre band exactly at the edge ratio boundary', () => {
    // 25% of a 400px pane is 100px from the left border.
    expect(zoneForPoint(PANE, { x: 199, y: 200 })).toBe('left');
    expect(zoneForPoint(PANE, { x: 200, y: 200 })).toBe('center');
  });
});

describe('preview geometry', () => {
  it('draws the halves an edge split creates and the whole pane for a tab drop', () => {
    expect(previewRectForZone(PANE, 'center')).toEqual(PANE);
    expect(previewRectForZone(PANE, 'left')).toEqual({ x: 100, y: 100, width: 200, height: 200 });
    expect(previewRectForZone(PANE, 'right')).toEqual({ x: 300, y: 100, width: 200, height: 200 });
    expect(previewRectForZone(PANE, 'top')).toEqual({ x: 100, y: 100, width: 400, height: 100 });
    expect(previewRectForZone(PANE, 'bottom')).toEqual({ x: 100, y: 200, width: 400, height: 100 });
  });

  it('sizes a split track the way the rendered grid resolves it', () => {
    // Ratio wins once both tracks clear the minmax floor.
    expect(splitTrackSize(1004, OUTER_EDGE_RATIO)).toBe(250);
    // The floor overrides a ratio that would undercut it...
    expect(splitTrackSize(400 + DOCK_SPLITTER_PX, 0.1)).toBe(DOCK_MIN_TRACK_PX);
    // ...and the sibling's floor caps a ratio that would starve it.
    expect(splitTrackSize(300 + DOCK_SPLITTER_PX, 0.9)).toBe(300 - DOCK_MIN_TRACK_PX);
    // Below two floors the browser shrinks both tracks equally.
    expect(splitTrackSize(100 + DOCK_SPLITTER_PX, OUTER_EDGE_RATIO)).toBe(50);
    expect(splitTrackSize(0, OUTER_EDGE_RATIO)).toBe(0);
  });

  it('draws the outer-edge strip at the track the grid will actually give it', () => {
    // 400px wide: (400 - 4px splitter) * 0.25 = 99, clear of the 96px floor.
    expect(previewRectForEdge(PANE, 'left')).toEqual({ x: 100, y: 100, width: 99, height: 200 });
    expect(previewRectForEdge(PANE, 'right')).toEqual({ x: 401, y: 100, width: 99, height: 200 });
    // 200px tall: (200 - 4) * 0.25 = 49, so the 96px floor wins instead.
    expect(previewRectForEdge(PANE, 'top')).toEqual({ x: 100, y: 100, width: 400, height: 96 });
    expect(previewRectForEdge(PANE, 'bottom')).toEqual({ x: 100, y: 204, width: 400, height: 96 });
  });

  it('converts an absolute rect into workspace-local coordinates', () => {
    expect(toLocalRect(PANE, { x: 50, y: 40, width: 800, height: 600 }))
      .toEqual({ x: 50, y: 60, width: 400, height: 200 });
  });
});

describe('edgeForPoint', () => {
  it('detects the hugged border and ignores the interior', () => {
    const workspace = { x: 0, y: 0, width: 1000, height: 600 };
    expect(edgeForPoint(workspace, { x: 5, y: 300 })).toBe('left');
    expect(edgeForPoint(workspace, { x: 995, y: 300 })).toBe('right');
    expect(edgeForPoint(workspace, { x: 500, y: 2 })).toBe('top');
    expect(edgeForPoint(workspace, { x: 500, y: 598 })).toBe('bottom');
    expect(edgeForPoint(workspace, { x: 500, y: 300 })).toBeNull();
    expect(edgeForPoint(workspace, { x: -5, y: 300 })).toBeNull();
  });
});

describe('tab reorder', () => {
  const tabs = [
    { paneId: PANE_TERMINAL, rect: { x: 0, y: 0, width: 100, height: 30 } },
    { paneId: PANE_MESS, rect: { x: 100, y: 0, width: 100, height: 30 } },
  ];

  it('inserts before the first tab whose midpoint the pointer passed', () => {
    expect(tabDropIndex(tabs, 10)).toBe(0);
    expect(tabDropIndex(tabs, 60)).toBe(1);
    expect(tabDropIndex(tabs, 190)).toBe(2);
    expect(tabDropIndex(tabs, 400)).toBe(2);
  });

  it('recognises an insertion that would rebuild the strip unchanged', () => {
    // Terminal already sits at 0 and Overview at 1, so those slots are no-ops.
    expect(isNoOpReorder(tabs, PANE_TERMINAL, 0)).toBe(true);
    expect(isNoOpReorder(tabs, PANE_TERMINAL, 1)).toBe(false);
    expect(isNoOpReorder(tabs, PANE_MESS, 1)).toBe(true);
    expect(isNoOpReorder(tabs, PANE_MESS, 0)).toBe(false);
    // An out-of-range index still resolves to the last slot.
    expect(isNoOpReorder(tabs, PANE_MESS, 9)).toBe(true);
    expect(isNoOpReorder(tabs, PANE_ARTIFACTS, 0)).toBe(false);
  });

  it('places the caret at the insertion boundary and clamps out-of-range indices', () => {
    const strip = { rect: { x: 0, y: 0, width: 300, height: 30 }, tabs };
    expect(previewRectForTabIndex(strip, 0).x).toBeCloseTo(-1.5);
    expect(previewRectForTabIndex(strip, 1).x).toBeCloseTo(98.5);
    expect(previewRectForTabIndex(strip, 9).x).toBeCloseTo(198.5);
  });
});

describe('resolveDrop', () => {
  const workspace = { x: 0, y: 0, width: 1000, height: 600 };
  const surfaces: DockDragSurface[] = [
    {
      paneId: PANE_TERMINAL,
      rect: { x: 0, y: 0, width: 600, height: 600 },
      tabStrip: {
        rect: { x: 0, y: 0, width: 600, height: 30 },
        tabs: [
          { paneId: PANE_TERMINAL, rect: { x: 0, y: 0, width: 100, height: 30 } },
          { paneId: PANE_MESS, rect: { x: 100, y: 0, width: 100, height: 30 } },
        ],
      },
    },
    {
      paneId: PANE_ARTIFACTS,
      rect: { x: 600, y: 0, width: 400, height: 600 },
      tabStrip: {
        rect: { x: 600, y: 0, width: 400, height: 30 },
        tabs: [{ paneId: PANE_ARTIFACTS, rect: { x: 600, y: 0, width: 100, height: 30 } }],
      },
    },
  ];

  it('prefers a tab strip over the workspace border it sits against', () => {
    expect(resolveDrop(PANE_TERMINAL, { x: 160, y: 5 }, surfaces, workspace))
      .toMatchObject({ kind: 'reorder', index: 1 });
  });

  it('treats a foreign tab strip as a centre (tabbed) drop', () => {
    expect(resolveDrop(PANE_TERMINAL, { x: 650, y: 10 }, surfaces, workspace))
      .toMatchObject({ kind: 'target', paneId: PANE_ARTIFACTS, zone: 'center' });
  });

  it('docks to an outer edge before splitting the pane underneath', () => {
    expect(resolveDrop(PANE_ARTIFACTS, { x: 4, y: 300 }, surfaces, workspace))
      .toMatchObject({ kind: 'edge', side: 'left' });
  });

  it('splits the pane under the pointer and reports the matching rectangle', () => {
    const drop = resolveDrop(PANE_ARTIFACTS, { x: 560, y: 300 }, surfaces, workspace);
    expect(drop).toMatchObject({ kind: 'target', paneId: PANE_TERMINAL, zone: 'right' });
    expect(drop?.rect).toEqual({ x: 300, y: 0, width: 300, height: 600 });
  });

  it('returns nothing when the pointer is outside every surface', () => {
    expect(resolveDrop(PANE_TERMINAL, { x: 2000, y: 2000 }, surfaces, workspace)).toBeNull();
  });

  it('resolves nothing when a tab is dropped back into its own slot', () => {
    // No preview and no drop, so the layout is never rewritten for a non-move.
    expect(resolveDrop(PANE_TERMINAL, { x: 10, y: 5 }, surfaces, workspace)).toBeNull();
    expect(resolveDrop(PANE_MESS, { x: 180, y: 5 }, surfaces, workspace)).toBeNull();
  });

  it('ignores a hidden group whose strip measures zero', () => {
    const collapsed: DockDragSurface[] = [{
      paneId: PANE_MESS,
      rect: { x: 0, y: 0, width: 0, height: 0 },
      tabStrip: {
        rect: { x: 0, y: 0, width: 0, height: 0 },
        tabs: [{ paneId: PANE_MESS, rect: { x: 0, y: 0, width: 0, height: 0 } }],
      },
    }];
    // Without the guard the collapsed strip would claim the workspace corner as
    // a centre drop onto a pane the user cannot even see.
    expect(resolveDrop(PANE_ARTIFACTS, { x: 0, y: 0 }, collapsed, workspace))
      .toMatchObject({ kind: 'edge', side: 'left' });
  });
});
